import { timingSafeEqual } from 'node:crypto';
import {
  IncrementalSyncResponseSchema,
  RealtimeServerMessageSchema,
  SyncSnapshotResponseSchema,
  TaskCommandResultSchema,
  TaskDetailResponseSchema,
  TaskListResponseSchema,
  WireApiErrorSchema,
} from '@fanshuye/contracts';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import type { AppConfig } from './config';
import type { DatabasePool } from './db/pool';
import { ApiError, sendError } from './lib/errors';
import {
  createRequestId,
  serializeErrorForLog,
  serializeRequestForLog,
  serializeResponseForLog,
} from './lib/logging';
import { isAllowedWebSocketOrigin } from './lib/security';
import { MetricsRegistry } from './observability/metrics';
import { AuthService } from './modules/auth/service';
import type { VerificationEmailSender } from './modules/auth/email';
import { requireMembership } from './modules/common/access';
import { PostgresDependencyRepository } from './modules/dependencies/repository';
import { EventHub, type RealtimeSocket } from './modules/sync/event-hub';
import { SyncService } from './modules/sync/service';
import {
  CreateTaskSchema,
  ExternalReferenceSchema,
  ListTasksQuerySchema,
  TaskCommandSchema,
  UuidSchema,
} from './modules/tasks/schemas';
import { TaskService } from './modules/tasks/service';
import { WorkspaceService } from './modules/workspaces/service';

const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((password) => /[A-Za-z]/.test(password) && /\d/.test(password), {
    message: 'Password must include letters and digits',
  });

const registerSchema = z.object({
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(100),
  password: passwordSchema,
});
const loginSchema = z.object({ email: z.email().max(320), password: z.string().min(1).max(128) });
const tokenSchema = z.object({ token: z.string().min(16).max(512) });
const refreshSchema = z.object({ refreshToken: z.string().min(32).max(512) });
const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((timeZone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Timezone must be a valid IANA timezone');
const workspaceSchema = z.object({
  commandId: UuidSchema,
  name: z.string().trim().min(1).max(120),
  timezone: timeZoneSchema.default('UTC'),
});
const invitationSchema = z.object({
  commandId: UuidSchema,
  email: z.email().max(320),
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});
const acceptInvitationSchema = z.object({
  commandId: UuidSchema,
  token: z.string().min(16).max(512),
});
const commandOnlySchema = z.object({ commandId: UuidSchema });
const memberRoleSchema = z.object({ commandId: UuidSchema, role: z.enum(['ADMIN', 'MEMBER']) });
const removeReferenceSchema = z.object({
  commandId: UuidSchema,
  expectedVersion: z.number().int().positive(),
});
const workspaceParamsSchema = z.object({ workspaceId: UuidSchema });
const sessionParamsSchema = z.object({ sessionId: UuidSchema });
const taskParamsSchema = z.object({ workspaceId: UuidSchema, taskId: UuidSchema });
const memberParamsSchema = z.object({ workspaceId: UuidSchema, userId: UuidSchema });
const referenceParamsSchema = z.object({
  workspaceId: UuidSchema,
  taskId: UuidSchema,
  referenceId: UuidSchema,
});

export interface BuildAppOptions {
  config: AppConfig;
  pool: DatabasePool;
  eventHub?: EventHub;
  metrics?: MetricsRegistry;
  verificationEmailSender?: VerificationEmailSender;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  if (options.config.NODE_ENV === 'production' && !options.verificationEmailSender) {
    throw new Error(
      'Production startup requires a VerificationEmailSender backed by a real email provider',
    );
  }
  const metrics = options.metrics ?? new MetricsRegistry();
  const eventHub = options.eventHub ?? new EventHub();
  eventHub.setConnectionObserver((count) => metrics.setWebsocketConnections(count));
  const commandStartedAt = new WeakMap<FastifyRequest, number>();
  const app = Fastify({
    logger: {
      level: options.config.LOG_LEVEL,
      serializers: {
        req: serializeRequestForLog,
        res: serializeResponseForLog,
        err: serializeErrorForLog,
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.sec-websocket-protocol',
          'req.body.password',
          'req.body.refreshToken',
          'req.body.token',
          'req.body.title',
          'req.body.description',
          'req.body.definitionOfDone',
          'req.body.reason',
          'res.headers.set-cookie',
        ],
        censor: '[REDACTED]',
      },
    },
    trustProxy: options.config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    genReqId: createRequestId,
  });

  await app.register(cors, {
    origin(origin, callback) {
      callback(null, !origin || options.config.allowedOrigins.includes(origin));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-correlation-id'],
  });
  await app.register(rateLimit, {
    global: true,
    max: 180,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      ...WireApiErrorSchema.parse({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          details: {},
          correlationId: null,
        },
      }),
    }),
  });
  await app.register(websocket, {
    options: { maxPayload: 8 * 1024 },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
    if (isWriteCommand(request)) commandStartedAt.set(request, performance.now());
  });
  app.addHook('onResponse', async (request, reply) => {
    const startedAt = commandStartedAt.get(request);
    if (startedAt === undefined) return;
    metrics.recordCommand(
      reply.statusCode < 400 ? 'success' : 'failure',
      performance.now() - startedAt,
    );
  });
  app.addHook('onError', async (_request, _reply, error) => {
    if (!(error instanceof ApiError)) return;
    if (error.code === 'VERSION_CONFLICT' || error.code === 'CLAIM_CONFLICT') {
      metrics.recordConflict(error.code);
    }
  });

  const authService = new AuthService(
    options.pool,
    options.config,
    eventHub,
    options.verificationEmailSender,
  );
  const workspaceService = new WorkspaceService(options.pool, eventHub);
  const dependencyRepository = new PostgresDependencyRepository(
    options.pool,
    options.config,
    metrics,
  );
  const taskService = new TaskService(
    options.pool,
    dependencyRepository,
    dependencyRepository,
    eventHub,
  );
  const syncService = new SyncService(options.pool, metrics);

  app.setErrorHandler((error, request, reply) => sendError(error, request, reply));
  app.setNotFoundHandler((request, reply) =>
    sendError(new ApiError(404, 'NOT_FOUND', 'Route is not available'), request, reply),
  );

  app.get('/health', async (_request, reply) => {
    try {
      await options.pool.query('SELECT 1');
      return reply.send({
        status: 'ok',
        database: 'ready',
        realtimeConnections: eventHub.connectionCount,
      });
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'unavailable' });
    }
  });

  app.get('/internal/metrics', { config: { rateLimit: false } }, async (request, reply) => {
    const expectedToken = options.config.METRICS_TOKEN;
    if (!expectedToken) {
      throw new ApiError(404, 'NOT_FOUND', 'Route is not available');
    }
    if (!hasMetricsAuthorization(request.headers.authorization, expectedToken)) {
      throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Metrics authorization is required');
    }
    return reply
      .header('cache-control', 'no-store')
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(metrics.renderPrometheus());
  });

  app.post(
    '/v1/auth/register',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = parse(registerSchema, request.body);
      const result = await authService.register(input);
      return reply.status(201).send(result);
    },
  );
  app.post(
    '/v1/auth/verify-email',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = parse(tokenSchema, request.body);
      await authService.verifyEmail(input.token);
      return reply.send({ verified: true });
    },
  );
  app.post(
    '/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = parse(loginSchema, request.body);
      const userAgentHeader = request.headers['user-agent'];
      return reply.send(
        await authService.login({
          ...input,
          userAgent: typeof userAgentHeader === 'string' ? userAgentHeader.slice(0, 500) : null,
          ipAddress: request.ip || null,
        }),
      );
    },
  );
  app.post(
    '/v1/auth/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = parse(refreshSchema, request.body);
      return reply.send(await authService.refresh(input.refreshToken));
    },
  );
  app.post('/v1/auth/logout', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    await authService.logout(auth);
    return reply.status(204).send();
  });
  app.delete('/v1/auth/sessions/:sessionId', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { sessionId } = parse(sessionParamsSchema, request.params);
    await authService.revokeSession(auth, sessionId);
    return reply.status(204).send();
  });

  app.get('/v1/workspaces', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    return reply.send({ workspaces: await workspaceService.list(auth) });
  });
  app.post('/v1/workspaces', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const input = parse(workspaceSchema, request.body);
    return reply.status(201).send(await workspaceService.create(auth, input));
  });
  app.get('/v1/workspaces/:workspaceId/members', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId } = parse(workspaceParamsSchema, request.params);
    return reply.send({ members: await workspaceService.listMembers(auth, workspaceId) });
  });
  app.post('/v1/workspaces/:workspaceId/invitations', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId } = parse(workspaceParamsSchema, request.params);
    const input = parse(invitationSchema, request.body);
    return reply.status(201).send(await workspaceService.invite(auth, workspaceId, input));
  });
  app.post('/v1/workspace-invitations/accept', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const input = parse(acceptInvitationSchema, request.body);
    return reply.send(await workspaceService.acceptInvitation(auth, input));
  });
  app.delete('/v1/workspaces/:workspaceId/members/:userId', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId, userId } = parse(memberParamsSchema, request.params);
    const { commandId } = parse(commandOnlySchema, request.body);
    return reply.send(await workspaceService.removeMember(auth, workspaceId, userId, commandId));
  });
  app.patch('/v1/workspaces/:workspaceId/members/:userId', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId, userId } = parse(memberParamsSchema, request.params);
    const input = parse(memberRoleSchema, request.body);
    return reply.send(await workspaceService.changeMemberRole(auth, workspaceId, userId, input));
  });

  app.get('/v1/workspaces/:workspaceId/tasks', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId } = parse(workspaceParamsSchema, request.params);
    const query = parse(ListTasksQuerySchema, request.query);
    return reply.send(
      TaskListResponseSchema.parse(await taskService.list(auth, workspaceId, query)),
    );
  });
  app.get('/v1/workspaces/:workspaceId/tasks/similar', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId } = parse(workspaceParamsSchema, request.params);
    const query = parse(
      z.object({
        title: z.string().trim().min(1).max(240),
        limit: z.coerce.number().int().min(1).max(20).default(8),
      }),
      request.query,
    );
    return reply.send({
      matches: await taskService.findSimilar(auth, workspaceId, query.title, query.limit),
    });
  });
  app.post('/v1/workspaces/:workspaceId/tasks', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId } = parse(workspaceParamsSchema, request.params);
    const input = parse(CreateTaskSchema, request.body);
    return reply
      .status(201)
      .send(TaskCommandResultSchema.parse(await taskService.create(auth, workspaceId, input)));
  });
  app.get('/v1/workspaces/:workspaceId/tasks/:taskId', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId, taskId } = parse(taskParamsSchema, request.params);
    return reply.send(
      TaskDetailResponseSchema.parse({ task: await taskService.get(auth, workspaceId, taskId) }),
    );
  });
  app.post('/v1/workspaces/:workspaceId/tasks/:taskId/commands', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId, taskId } = parse(taskParamsSchema, request.params);
    const command = parse(TaskCommandSchema, request.body);
    return reply.send(
      TaskCommandResultSchema.parse(await taskService.execute(auth, workspaceId, taskId, command)),
    );
  });
  app.get('/v1/workspaces/:workspaceId/tasks/:taskId/timeline', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId, taskId } = parse(taskParamsSchema, request.params);
    return reply.send({ events: await taskService.timeline(auth, workspaceId, taskId) });
  });
  app.post(
    '/v1/workspaces/:workspaceId/tasks/:taskId/external-references',
    async (request, reply) => {
      const auth = await authService.authenticateRequest(request);
      const { workspaceId, taskId } = parse(taskParamsSchema, request.params);
      const input = parse(ExternalReferenceSchema, request.body);
      return reply
        .status(201)
        .send(
          TaskCommandResultSchema.parse(
            await taskService.addExternalReference(auth, workspaceId, taskId, input),
          ),
        );
    },
  );
  app.delete(
    '/v1/workspaces/:workspaceId/tasks/:taskId/external-references/:referenceId',
    async (request, reply) => {
      const auth = await authService.authenticateRequest(request);
      const { workspaceId, taskId, referenceId } = parse(referenceParamsSchema, request.params);
      const input = parse(removeReferenceSchema, request.body);
      return reply.send(
        TaskCommandResultSchema.parse(
          await taskService.removeExternalReference(
            auth,
            workspaceId,
            taskId,
            referenceId,
            input.commandId,
            input.expectedVersion,
          ),
        ),
      );
    },
  );
  app.get(
    '/v1/workspaces/:workspaceId/tasks/:taskId/dependencies/prerequisites',
    async (request, reply) => {
      const auth = await authService.authenticateRequest(request);
      const { workspaceId, taskId } = parse(taskParamsSchema, request.params);
      await requireMembership(options.pool, workspaceId, auth.userId);
      return reply.send({
        tasks: await dependencyRepository.getPrerequisiteDetails(workspaceId, taskId),
      });
    },
  );
  app.get(
    '/v1/workspaces/:workspaceId/tasks/:taskId/dependencies/dependents',
    async (request, reply) => {
      const auth = await authService.authenticateRequest(request);
      const { workspaceId, taskId } = parse(taskParamsSchema, request.params);
      await requireMembership(options.pool, workspaceId, auth.userId);
      return reply.send({
        tasks: await dependencyRepository.getDependentDetails(workspaceId, taskId),
      });
    },
  );
  app.get(
    '/v1/workspaces/:workspaceId/tasks/:taskId/dependencies/impact',
    async (request, reply) => {
      const auth = await authService.authenticateRequest(request);
      const { workspaceId, taskId } = parse(taskParamsSchema, request.params);
      await requireMembership(options.pool, workspaceId, auth.userId);
      return reply.send({
        nodes: await dependencyRepository.getImpactNodes(workspaceId, taskId),
      });
    },
  );

  app.get('/v1/workspaces/:workspaceId/sync/snapshot', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId } = parse(workspaceParamsSchema, request.params);
    return reply.send(
      SyncSnapshotResponseSchema.parse(await syncService.snapshot(auth, workspaceId)),
    );
  });
  app.get('/v1/workspaces/:workspaceId/sync/events', async (request, reply) => {
    const auth = await authService.authenticateRequest(request);
    const { workspaceId } = parse(workspaceParamsSchema, request.params);
    const query = parse(
      z.object({
        after: z.coerce.number().int().min(0),
        limit: z.coerce.number().int().min(1).max(1_000).default(500),
      }),
      request.query,
    );
    return reply.send(
      IncrementalSyncResponseSchema.parse(
        await syncService.incremental(auth, workspaceId, query.after, query.limit),
      ),
    );
  });

  app.get('/v1/workspaces/:workspaceId/ws', { websocket: true }, (socket, request) => {
    void authorizeWebSocket(request, socket as unknown as RealtimeSocket & SocketEvents);
  });

  async function authorizeWebSocket(
    request: FastifyRequest,
    socket: RealtimeSocket & SocketEvents,
  ): Promise<void> {
    try {
      const origin = request.headers.origin;
      if (
        !isAllowedWebSocketOrigin(
          typeof origin === 'string' ? origin : undefined,
          options.config.allowedOrigins,
        )
      ) {
        throw new ApiError(403, 'FORBIDDEN', 'WebSocket origin is not allowed');
      }
      const auth = await authService.authenticateWebSocketRequest(request);
      const { workspaceId } = parse(workspaceParamsSchema, request.params);
      await requireMembership(options.pool, workspaceId, auth.userId);
      const unsubscribe = eventHub.subscribe({
        workspaceId,
        userId: auth.userId,
        sessionId: auth.sessionId,
        socket,
      });
      socket.send(
        JSON.stringify(
          RealtimeServerMessageSchema.parse({ type: 'ready', workspaceId, schemaVersion: 1 }),
        ),
      );
      socket.on('message', (data) => {
        if (String(data) === 'ping') {
          socket.send(JSON.stringify(RealtimeServerMessageSchema.parse({ type: 'pong' })));
        }
      });
      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);
    } catch (error) {
      request.log.warn({ err: error }, 'websocket authorization rejected');
      socket.close(4003, 'authorization failed');
    }
  }

  return app;
}

interface SocketEvents {
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Request validation failed', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function isWriteCommand(request: FastifyRequest): boolean {
  return (
    (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') &&
    Boolean(request.raw.url?.startsWith('/v1/'))
  );
}

function hasMetricsAuthorization(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  const suppliedToken = authorization.slice('Bearer '.length);
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
