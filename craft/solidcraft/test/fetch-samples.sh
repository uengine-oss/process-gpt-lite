#!/bin/sh
# 라이선스를 확인하지 못한 표본은 저장소에 넣지 않는다: 시험 전에 받는다(pythonocc-demos)
cd "$(dirname "$0")/fixtures" || exit 1
for f in face_recognition_sample_part.stp:sample_part.stp surf114.igs:surf114.igs curve_geom_plate.igs:curve_geom_plate.igs; do
  curl -sSL -m 60 -o "${f#*:}" "https://raw.githubusercontent.com/tpaviot/pythonocc-demos/master/assets/models/${f%:*}"
done
