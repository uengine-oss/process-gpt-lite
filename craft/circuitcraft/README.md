# CircuitCraft

A browser circuit tool in the style of PSpice, part of the Craft app series. It opens PSpice documents
(`.cir .net .ckt .sp .lib .mod`, with their `.lib`/`.inc` files), draws them as a schematic, simulates them with
NGSpice compiled to WebAssembly, and saves them back as PSpice text.

Based on **[WebSpice](https://github.com/jwt625/WebSpice)** by jwt625 (MIT): the schematic editor, waveform viewer and
engine wrapper come from there. The upstream repository states the MIT license in its README and has no LICENSE file.

## Build and test

```sh
./build.sh                      # builds and copies to ../../../artcraft/web/circuitcraft (CIRCUITCRAFT_WEB_DIR to change)
node --test test/circuitcraft.e2e.mjs   # against that build, on port 5281 (CC_WEB_DIR, CC_PORT, CC_SHOTS)
pnpm dev                        # http://127.0.0.1:5281/craft/circuitcraft/
```

## How a document flows

- **Text is the document.** `src/lib/pspice/document.ts` knows which physical lines hold which element. A schematic edit
  changes only those lines, so an unedited file saves byte for byte (line ends and old code pages included).
- **Every simulation goes through `toNgspice`** (`../pspice/pspice.mjs`, shared with the CLI): raw PSpice files fail or
  give wrong values in ngspice. A schematic drawn from scratch is PSpice text too and takes the same path.
- **The drawing** (`src/lib/pspice/layout.ts`): ELK places the signal path, shunts hang off their nets, a small maze router
  draws grid wires that never touch another net, ground is a symbol, supply rails are net labels. The result is read back
  through the connectivity analysis; a net that does not come out exact is drawn with labels instead.
- **The engine** (`src/lib/simulation`): ngspice's fatal errors call `exit(1)` and the engine's promise never settles. A
  run ends with a result, with stderr saying the instance is gone, or with a timeout; the last two replace the worker.
  `eecircuit-engine` is pinned exactly because the worker uses two of its internals (see `simulation.worker.ts`).

## Host bridge (`?host=parent`)

Posts `circuitcraft:ready`, `circuitcraft:dirty {dirty}`, `circuitcraft:save {name, bytes}` (Cmd/Ctrl+S; CSV exports come the
same way), `circuitcraft:failed {error}` to a parent on the same origin, and accepts
`circuitcraft:open {name, bytes, files?: [{name, bytes}]}`. The page also exposes
`window.circuitcraft = { openFile(name, bytes, files), runAll(), getState(), ... }`.

## Keyboard

| Key | Function |
|-----|----------|
| R, C, L, V, I, G, D, Q, M, N | Place component (N: net label) |
| W or 3 | Wire mode |
| 5 / 6 / 7 | Delete / duplicate / move mode |
| P | Probe mode |
| F | Fit the drawing |
| Ctrl+R / Ctrl+E | Rotate / mirror selected |
| Ctrl+B | Run every analysis |
| Ctrl+S | Save `.cir` |
| Ctrl+O | Open |

## Acknowledgments

- **WebSpice** by jwt625, the base of this app
- **NGSpice**, the simulator
- **EEcircuit** / eecircuit-engine, NGSpice as WebAssembly (MIT)
- **Eclipse Layout Kernel** / elkjs, the placement
- **LTSpice**, the inspiration for the original UI and shortcuts

## License

MIT, as upstream.
