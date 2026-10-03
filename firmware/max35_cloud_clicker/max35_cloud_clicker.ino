#include "classroom_config.h"
#include <ClassroomClient.h>

ClassroomClient classroom;
String serialLine;

void setup() {
  Serial.begin(115200);
  classroom.begin();
  Serial.println("[boot] max35_cloud_clicker; HELP for commands");
}

void loop() {
  classroom.tick();
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialLine.length() && !classroom.command(serialLine)) Serial.println("Unsupported command");
      serialLine = "";
    } else if (serialLine.length() < 64) serialLine += c;
  }
  delay(5);
}
