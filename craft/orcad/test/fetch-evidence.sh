#!/usr/bin/env bash
# Downloads the real designs and the published files they are checked against.
#   craft/orcad/test/fetch-evidence.sh /some/dir
#   ORCAD_TEST_DIR=/some/dir node --test craft/orcad/test/dsn.test.mjs
set -euo pipefail
dir="${1:?usage: fetch-evidence.sh <directory>}"
mkdir -p "$dir"
xm=https://raw.githubusercontent.com/beagleboard/beagleboard-xm/master
ai=https://raw.githubusercontent.com/beagleboard/beaglebone-ai/master
get() { [ -s "$dir/$2" ] || curl -fsSL -o "$dir/$2" "$1"; }
get "$xm/SCH/BeagleBoard-xM_ORCAD.DSN"                     BeagleBoard-xM_ORCAD.DSN
get "$xm/PCB/GERBER/BeagleBoard_xM_RevC1_IPC356A.ipc"      BeagleBoard_xM_RevC1_IPC356A.ipc
get "$xm/BeagleBoard-xM_SCH.pdf"                           BeagleBoard-xM_SCH.pdf
get "$xm/BeagleBoard-xM_BOM.xlsx"                          BeagleBoard-xM_BOM.xlsx
get "$ai/HW/BeagleBone-AI.dsn"                             BeagleBone-AI.dsn
get "$ai/HW/cds2f_BeagleBone-AI.txt"                       cds2f_BeagleBone-AI.txt
get "$ai/BeagleBone-AI_sch.pdf"                            BeagleBone-AI_sch.pdf
get "$ai/BeagleBone-AI_bom.csv"                            BeagleBone-AI_bom.csv
ls -la "$dir"

# Capture 가 직접 만든 넷리스트(.net, .als)와의 대조는 PSpice 프로젝트 묶음을 쓴다. 저장소에 넣지 않는다.
# 예: CMOSedu PSpice 예제, dweggg/inverter, lab11/signpost, killerzman/OrCAD-AudioPowerAmplifier, sina96n/ua741-Design-and-Simulation.
# 그런 폴더를 함께 준다: ORCAD_TEST_DIR=/some/dir:/some/projects node --test craft/orcad/test/dsn.test.mjs
