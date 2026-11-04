#!/usr/bin/env python3
"""Reads a STEP or IGES file with cadquery-ocp and prints what is really in it, as JSON: bounding box,
volume, solid and face counts, overall and per solid. This is the independent witness for SolidCraft's
tests: its own OCCT build and its own readers, sharing no code with the Chili3D WASM kernel.

usage: check_geometry.py FILE
"""
import json
import os
import pathlib
import sys

from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.IGESControl import IGESControl_Reader
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer


def read(path):
    reader = STEPControl_Reader() if path.suffix.lower() in (".step", ".stp") else IGESControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        raise SystemExit(f"cannot read {path}")
    reader.TransferRoots()
    return reader.OneShape()


def bbox(shape):
    box = Bnd_Box()
    # AddOptimal: from the surfaces themselves, without the shape's tolerance
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    low, high = box.CornerMin(), box.CornerMax()
    return {
        "min": [low.X(), low.Y(), low.Z()],
        "max": [high.X(), high.Y(), high.Z()],
        "size": [high.X() - low.X(), high.Y() - low.Y(), high.Z() - low.Z()],
    }


def volume(shape):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return props.Mass()


def children(shape, kind):
    explorer = TopExp_Explorer(shape, kind)
    while explorer.More():
        yield explorer.Current()
        explorer.Next()


def main():
    # OCCT's readers print to the process's stdout; only our JSON may go there
    stdout = os.dup(1)
    os.dup2(2, 1)
    path = pathlib.Path(sys.argv[1])
    shape = read(path)
    solids = list(children(shape, TopAbs_SOLID))
    per_solid = [{"bbox": bbox(s), "volume": volume(s), "faces": sum(1 for _ in children(s, TopAbs_FACE)), "valid": BRepCheck_Analyzer(s).IsValid()} for s in solids]
    os.write(stdout, json.dumps({
        "file": path.name,
        "bbox": bbox(shape),
        "volume": sum(s["volume"] for s in per_solid),
        "solids": len(solids),
        "shells": sum(1 for _ in children(shape, TopAbs_SHELL)),
        "faces": sum(1 for _ in children(shape, TopAbs_FACE)),
        "per_solid": per_solid,
    }).encode() + b"\n")


main()
