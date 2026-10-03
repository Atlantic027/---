/*
  ESP32S3-MAX35 terminal reference model

  Reference:
  - Spotpear ESP32S3-MAX35 board documentation and official STEP resource
  - Official STEP is available, but its full assembly bounds have NOT been measured.

  This is a configurable visual/reference model, not a manufacturing-ready enclosure.
  Screen, camera, connector and speaker locations are deliberately exposed as parameters
  because the source page identifies the components but does not publish a dimensioned
  mechanical drawing for every feature.

  Coordinate system: X = left/right, Y = bottom/top, Z = board upward. Units: mm.
*/

$fn = 48;

// Render selection: 0 assembly, 1 board, 2 display, 3 case_front, 4 case_back.
render_part = 0;
show_labels = true;
show_board_detail = true;

// Concept dimensions, NOT measured manufacturer dimensions.
board_w = 163;
board_h = 104;
board_t = 0.8;
board_corner = 3;

// Reference display module for the documented 3.5-inch ST7796S panel.
display_w = 95;
display_h = 70;
display_t = 5.4;
view_w = 74;
view_h = 50;
display_x = 18;
display_y = 17;

// Approximate visual features. Measure the physical board before fabrication.
camera_d = 11;
camera_x = board_w - 18;
camera_y = board_h - 20;
usb_w = 10;
usb_h = 4;
usb_x = 14;
sd_w = 15;
sd_h = 2.5;
speaker_d = 28;
speaker_x = 132;
speaker_y = 25;
button_d = 6;
boot_x = 145;
boot_y = 78;
power_x = 145;
power_y = 64;

// Optional printable two-piece enclosure shell.
case_wall = 2.2;
case_clearance = 0.8;
case_floor = 2;
case_lip = 2;
case_corner = 7;

module rounded_box(size = [10, 10, 10], r = 2) {
  linear_extrude(height = size[2])
    translate([r,r])
    offset(r = r)
      square([size[0] - 2 * r, size[1] - 2 * r]);
}

module board_outline(height = board_t) {
  color([0.04, 0.28, 0.12])
    rounded_box([board_w, board_h, height], board_corner);
}

module mounting_holes() {
  for (p = [[5, 5], [board_w - 5, 5], [5, board_h - 5], [board_w - 5, board_h - 5]])
    translate([p[0], p[1], -1]) cylinder(d = 3, h = board_t + 2);
}

module pcb() {
  difference() {
    board_outline();
    mounting_holes();
  }
}

module display_module() {
  translate([display_x, display_y, board_t]) {
    color([0.06, 0.07, 0.09]) rounded_box([display_w, display_h, display_t], 3);
    translate([(display_w - view_w) / 2, (display_h - view_h) / 2, display_t])
      color([0.04, 0.27, 0.38, 0.92]) cube([view_w, view_h, 0.5]);
  }
}

module camera_module() {
  translate([camera_x, camera_y, board_t]) {
    color([0.12, 0.12, 0.14]) cylinder(d = camera_d + 6, h = 5);
    translate([0, 0, 5]) color([0.02, 0.04, 0.05]) cylinder(d = camera_d, h = 2);
    translate([0, 0, 7]) color([0.2, 0.45, 0.56]) cylinder(d = camera_d - 3, h = 0.4);
  }
}

module usb_c() {
  translate([usb_x, -1.5, board_t])
    color([0.62, 0.65, 0.68]) cube([usb_w, 5, usb_h]);
}

module sd_slot() {
  translate([board_w - sd_w - 13, board_h - 2, board_t])
    color([0.52, 0.54, 0.57]) cube([sd_w, 3.5, sd_h]);
}

module speaker() {
  translate([speaker_x, speaker_y, board_t]) {
    color([0.1, 0.1, 0.1]) cylinder(d = speaker_d, h = 4);
    for (angle = [0 : 30 : 330])
      rotate([0, 0, angle]) translate([speaker_d * 0.28, 0, 4]) color([0.4, 0.4, 0.4]) cylinder(d = 1.8, h = 0.4);
  }
}

module tactile_button(x, y, label) {
  translate([x, y, board_t]) {
    color([0.24, 0.26, 0.29]) cylinder(d = button_d, h = 2.5);
    if (show_labels)
      translate([0, 0, 2.6]) color("white") linear_extrude(0.25) text(label, size = 3.2, halign = "center", valign = "center");
  }
}

module pcb_detail() {
  usb_c();
  sd_slot();
  camera_module();
  speaker();
  tactile_button(boot_x, boot_y, "BOOT");
  tactile_button(power_x, power_y, "PWR");
}

module terminal_assembly() {
  pcb();
  display_module();
  if (show_board_detail) pcb_detail();
}

module case_outer() {
  rounded_box([board_w + 2 * (case_wall + case_clearance), board_h + 2 * (case_wall + case_clearance), display_t + board_t + case_floor + case_lip + 3], case_corner);
}

module case_front() {
  outer_w = board_w + 2 * (case_wall + case_clearance);
  outer_h = board_h + 2 * (case_wall + case_clearance);
  difference() {
    case_outer();
    translate([case_wall, case_wall, case_wall]) rounded_box([outer_w - 2 * case_wall, outer_h - 2 * case_wall, 30], max(2, case_corner - case_wall));
    translate([display_x + case_wall + case_clearance - 2, display_y + case_wall + case_clearance - 2, -1]) rounded_box([display_w + 4, display_h + 4, 20], 4);
    translate([camera_x + case_wall + case_clearance, camera_y + case_wall + case_clearance, -1]) cylinder(d = camera_d + 3, h = 20);
  }
}

module case_back() {
  outer_w = board_w + 2 * (case_wall + case_clearance);
  outer_h = board_h + 2 * (case_wall + case_clearance);
  difference() {
    rounded_box([outer_w, outer_h, case_floor + case_lip], case_corner);
    translate([case_wall, case_wall, case_floor]) rounded_box([outer_w - 2 * case_wall, outer_h - 2 * case_wall, case_lip + 2], max(2, case_corner - case_wall));
    translate([usb_x + case_wall + case_clearance - 1, -1, 1]) cube([usb_w + 2, case_wall + 3, usb_h + 3]);
    for (p = [[speaker_x, speaker_y]])
      translate([p[0] + case_wall + case_clearance, p[1] + case_wall + case_clearance, -1]) cylinder(d = speaker_d - 4, h = case_floor + 2);
  }
}

if (render_part == 1) pcb();
else if (render_part == 2) display_module();
else if (render_part == 3) case_front();
else if (render_part == 4) case_back();
else terminal_assembly();
