#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OverlayMode {
    Collapsed,
    Preview,
    Pinned,
}

impl OverlayMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "collapsed" => Ok(Self::Collapsed),
            "preview" => Ok(Self::Preview),
            "pinned" => Ok(Self::Pinned),
            _ => Err("悬浮窗状态无效".into()),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Collapsed => "collapsed",
            Self::Preview => "preview",
            Self::Pinned => "pinned",
        }
    }

    pub fn logical_size(self) -> LogicalSize {
        match self {
            Self::Collapsed => LogicalSize::new(176.0, 216.0),
            Self::Preview => LogicalSize::new(420.0, 236.0),
            Self::Pinned => LogicalSize::new(1_080.0, 760.0),
        }
    }

    pub fn accepts_keyboard_focus(self) -> bool {
        matches!(self, Self::Preview | Self::Pinned)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Edge {
    Left,
    Right,
}

impl Edge {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "left" => Ok(Self::Left),
            "right" => Ok(Self::Right),
            _ => Err("悬浮窗边缘设置无效".into()),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OverlayPresentation {
    Floating,
    SidePanel,
}

impl OverlayPresentation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Floating => "floating",
            Self::SidePanel => "sidePanel",
        }
    }

    pub fn parse(value: &str) -> Self {
        if value == "sidePanel" {
            Self::SidePanel
        } else {
            Self::Floating
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LogicalSize {
    pub width: f64,
    pub height: f64,
}

impl LogicalSize {
    const fn new(width: f64, height: f64) -> Self {
        Self { width, height }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PhysicalWindow {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WindowPlacement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MonitorCandidate {
    pub key: String,
    pub primary: bool,
}

const FLOATING_MARGIN_LOGICAL: f64 = 14.0;
const SIDE_PANEL_WIDTH_LOGICAL: f64 = 420.0;

pub fn sanitize_scale(scale: f64) -> f64 {
    if scale.is_finite() {
        scale.clamp(0.5, 4.0)
    } else {
        1.0
    }
}

fn scaled(value: f64, scale: f64) -> u32 {
    (value * sanitize_scale(scale))
        .round()
        .clamp(1.0, u32::MAX as f64) as u32
}

fn saturating_i32(value: i64) -> i32 {
    value.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

pub fn vertical_anchor(
    window_y: i32,
    window_height: u32,
    work_area: PhysicalRect,
    scale: f64,
) -> f64 {
    let margin = scaled(FLOATING_MARGIN_LOGICAL, scale);
    let available = work_area
        .height
        .saturating_sub(window_height)
        .saturating_sub(margin.saturating_mul(2));
    if available == 0 {
        return 0.0;
    }
    let relative = window_y as i64 - work_area.y as i64 - margin as i64;
    (relative as f64 / available as f64).clamp(0.0, 1.0)
}

pub fn horizontal_anchor(
    window_x: i32,
    window_width: u32,
    work_area: PhysicalRect,
    scale: f64,
) -> f64 {
    let margin = scaled(FLOATING_MARGIN_LOGICAL, scale);
    let available = work_area
        .width
        .saturating_sub(window_width)
        .saturating_sub(margin.saturating_mul(2));
    if available == 0 {
        return 0.0;
    }
    let relative = window_x as i64 - work_area.x as i64 - margin as i64;
    (relative as f64 / available as f64).clamp(0.0, 1.0)
}

pub fn place_overlay(
    mode: OverlayMode,
    presentation: OverlayPresentation,
    work_area: PhysicalRect,
    scale: f64,
    edge: Edge,
    saved_vertical_anchor: f64,
    saved_horizontal_anchor: Option<f64>,
) -> WindowPlacement {
    let scale = sanitize_scale(scale);
    let anchor = if saved_vertical_anchor.is_finite() {
        saved_vertical_anchor.clamp(0.0, 1.0)
    } else {
        0.2
    };

    if presentation == OverlayPresentation::SidePanel {
        let width = scaled(SIDE_PANEL_WIDTH_LOGICAL, scale).min(work_area.width.max(1));
        let x = match edge {
            Edge::Left => work_area.x,
            Edge::Right => {
                saturating_i32(work_area.x as i64 + work_area.width as i64 - width as i64)
            }
        };
        return WindowPlacement {
            x,
            y: work_area.y,
            width,
            height: work_area.height.max(1),
        };
    }

    let margin = scaled(FLOATING_MARGIN_LOGICAL, scale);
    let logical_size = mode.logical_size();
    let max_width = work_area
        .width
        .saturating_sub(margin.saturating_mul(2))
        .max(1);
    let max_height = work_area
        .height
        .saturating_sub(margin.saturating_mul(2))
        .max(1);
    let width = scaled(logical_size.width, scale).min(max_width);
    let height = scaled(logical_size.height, scale).min(max_height);
    let default_horizontal_anchor = match edge {
        Edge::Left => 0.0,
        Edge::Right => 1.0,
    };
    let horizontal = saved_horizontal_anchor
        .filter(|value| value.is_finite())
        .unwrap_or(default_horizontal_anchor)
        .clamp(0.0, 1.0);
    let available_x = work_area
        .width
        .saturating_sub(width)
        .saturating_sub(margin.saturating_mul(2));
    let x = saturating_i32(
        work_area.x as i64 + margin as i64 + (available_x as f64 * horizontal).round() as i64,
    );
    let available_y = work_area
        .height
        .saturating_sub(height)
        .saturating_sub(margin.saturating_mul(2));
    let y = saturating_i32(
        work_area.y as i64 + margin as i64 + (available_y as f64 * anchor).round() as i64,
    );
    WindowPlacement {
        x,
        y,
        width,
        height,
    }
}

pub fn is_safely_visible(window: PhysicalWindow, work_areas: &[PhysicalRect]) -> bool {
    const MIN_VISIBLE: i64 = 32;
    work_areas.iter().any(|area| {
        let left = (window.x as i64).max(area.x as i64);
        let top = (window.y as i64).max(area.y as i64);
        let right = (window.x as i64 + window.width as i64).min(area.x as i64 + area.width as i64);
        let bottom =
            (window.y as i64 + window.height as i64).min(area.y as i64 + area.height as i64);
        right - left >= MIN_VISIBLE && bottom - top >= MIN_VISIBLE
    })
}

pub fn choose_monitor_index(
    monitors: &[MonitorCandidate],
    preferred: Option<&str>,
    saved: Option<&str>,
    current: Option<&str>,
) -> Option<usize> {
    for wanted in [preferred, saved, current].into_iter().flatten() {
        if let Some(index) = monitors.iter().position(|monitor| monitor.key == wanted) {
            return Some(index);
        }
    }
    monitors
        .iter()
        .position(|monitor| monitor.primary)
        .or((!monitors.is_empty()).then_some(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work_area() -> PhysicalRect {
        PhysicalRect {
            x: -1_920,
            y: 0,
            width: 1_920,
            height: 1_040,
        }
    }

    #[test]
    fn overlay_modes_validate_dimensions_and_focus_policy() {
        assert_eq!(OverlayMode::parse("collapsed"), Ok(OverlayMode::Collapsed));
        assert_eq!(OverlayMode::parse("preview"), Ok(OverlayMode::Preview));
        assert_eq!(OverlayMode::parse("pinned"), Ok(OverlayMode::Pinned));
        assert!(OverlayMode::parse("expanded").is_err());
        assert!(OverlayMode::Preview.accepts_keyboard_focus());
        assert!(OverlayMode::Pinned.accepts_keyboard_focus());
    }

    #[test]
    fn dpi_matrix_preserves_logical_size_and_bounds() {
        for (scale, expected_width, expected_height) in [
            (1.0, 420, 236),
            (1.25, 525, 295),
            (1.5, 630, 354),
            (2.0, 840, 472),
        ] {
            let placement = place_overlay(
                OverlayMode::Preview,
                OverlayPresentation::Floating,
                work_area(),
                scale,
                Edge::Right,
                0.5,
                None,
            );
            assert_eq!(placement.width, expected_width);
            assert_eq!(placement.height, expected_height);
            assert!(placement.x >= work_area().x);
            assert!(placement.y >= work_area().y);
            assert!(placement.x as i64 + placement.width as i64 <= 0);
            assert!(placement.y as i64 + placement.height as i64 <= 1_040);
        }
    }

    #[test]
    fn collapsed_task_plant_scales_and_stays_inside_the_work_area() {
        for (scale, expected_width, expected_height) in [
            (1.0, 176, 216),
            (1.25, 220, 270),
            (1.5, 264, 324),
            (2.0, 352, 432),
        ] {
            let placement = place_overlay(
                OverlayMode::Collapsed,
                OverlayPresentation::Floating,
                work_area(),
                scale,
                Edge::Right,
                0.5,
                None,
            );
            assert_eq!(placement.width, expected_width);
            assert_eq!(placement.height, expected_height);
            assert!(placement.x >= work_area().x);
            assert!(placement.y >= work_area().y);
            assert!(placement.x as i64 + placement.width as i64 <= 0);
            assert!(placement.y as i64 + placement.height as i64 <= 1_040);
        }
    }

    #[test]
    fn side_panel_uses_work_area_and_requested_edge() {
        let right = place_overlay(
            OverlayMode::Collapsed,
            OverlayPresentation::SidePanel,
            work_area(),
            1.25,
            Edge::Right,
            0.9,
            None,
        );
        assert_eq!(
            right,
            WindowPlacement {
                x: -525,
                y: 0,
                width: 525,
                height: 1_040
            }
        );

        let left = place_overlay(
            OverlayMode::Pinned,
            OverlayPresentation::SidePanel,
            work_area(),
            2.0,
            Edge::Left,
            0.0,
            None,
        );
        assert_eq!(left.x, -1_920);
        assert_eq!(left.width, 840);
    }

    #[test]
    fn out_of_bounds_detection_requires_a_recoverable_visible_region() {
        let areas = [work_area()];
        assert!(is_safely_visible(
            PhysicalWindow {
                x: -100,
                y: 20,
                width: 176,
                height: 216
            },
            &areas,
        ));
        assert!(!is_safely_visible(
            PhysicalWindow {
                x: 20,
                y: 20,
                width: 176,
                height: 216
            },
            &areas,
        ));
        assert!(!is_safely_visible(
            PhysicalWindow {
                x: i32::MAX,
                y: i32::MAX,
                width: 176,
                height: 216
            },
            &areas,
        ));
    }

    #[test]
    fn monitor_selection_survives_unplug_and_replug() {
        let monitors = vec![
            MonitorCandidate {
                key: "primary".into(),
                primary: true,
            },
            MonitorCandidate {
                key: "vertical".into(),
                primary: false,
            },
        ];
        assert_eq!(
            choose_monitor_index(&monitors, Some("vertical"), None, None),
            Some(1)
        );
        assert_eq!(
            choose_monitor_index(&monitors[..1], Some("vertical"), Some("vertical"), None),
            Some(0)
        );
        assert_eq!(
            choose_monitor_index(&monitors, None, None, Some("vertical")),
            Some(1)
        );
        assert_eq!(
            choose_monitor_index(&[], Some("vertical"), None, None),
            None
        );
    }

    #[test]
    fn saved_vertical_anchor_is_dpi_independent() {
        let area = PhysicalRect {
            x: 0,
            y: 0,
            width: 2_560,
            height: 1_400,
        };
        let first = place_overlay(
            OverlayMode::Collapsed,
            OverlayPresentation::Floating,
            area,
            1.25,
            Edge::Right,
            0.65,
            None,
        );
        let anchor = vertical_anchor(first.y, first.height, area, 1.25);
        let restored = place_overlay(
            OverlayMode::Collapsed,
            OverlayPresentation::Floating,
            area,
            2.0,
            Edge::Right,
            anchor,
            None,
        );
        assert!((vertical_anchor(restored.y, restored.height, area, 2.0) - 0.65).abs() < 0.002);
    }

    #[test]
    fn saved_horizontal_anchor_is_dpi_and_size_independent() {
        let area = PhysicalRect {
            x: 0,
            y: 0,
            width: 2_560,
            height: 1_400,
        };
        let collapsed = place_overlay(
            OverlayMode::Collapsed,
            OverlayPresentation::Floating,
            area,
            1.25,
            Edge::Right,
            0.5,
            Some(0.36),
        );
        let anchor = horizontal_anchor(collapsed.x, collapsed.width, area, 1.25);
        assert!((anchor - 0.36).abs() < 0.002);

        let pinned = place_overlay(
            OverlayMode::Pinned,
            OverlayPresentation::Floating,
            area,
            2.0,
            Edge::Right,
            0.5,
            Some(anchor),
        );
        assert!(pinned.x >= area.x);
        assert!(pinned.x as i64 + pinned.width as i64 <= area.width as i64);
        assert!((horizontal_anchor(pinned.x, pinned.width, area, 2.0) - 0.36).abs() < 0.002);
    }

    #[test]
    fn missing_horizontal_anchor_uses_the_requested_edge() {
        let left = place_overlay(
            OverlayMode::Collapsed,
            OverlayPresentation::Floating,
            work_area(),
            1.0,
            Edge::Left,
            0.2,
            None,
        );
        let right = place_overlay(
            OverlayMode::Collapsed,
            OverlayPresentation::Floating,
            work_area(),
            1.0,
            Edge::Right,
            0.2,
            None,
        );
        assert!(left.x < right.x);
        assert_eq!(horizontal_anchor(left.x, left.width, work_area(), 1.0), 0.0);
        assert_eq!(
            horizontal_anchor(right.x, right.width, work_area(), 1.0),
            1.0
        );
    }
}
