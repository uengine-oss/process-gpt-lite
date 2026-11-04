#!/bin/sh
# 벤더 모델 표본을 받는다(PySpice 저장소의 공개 라이브러리). 저작권 표시가 있어 저장소에 넣지 않는다.
cd "$(dirname "$0")/fixtures" || exit 1
B=https://raw.githubusercontent.com/PySpice-org/PySpice/master/examples/libraries
for f in diode/switching/1N4148.lib diode/zener/1N5919B.lib mosfet/irf150.lib operational-amplifier/LMV981.MOD transistor/2N2222A.lib; do
  curl -sSL -m 60 -O "$B/$f"
done
