# Font provenance

The two font files in this directory are **Modified Versions** under the SIL
Open Font License 1.1: a Latin subset, converted to WOFF2, with the weight axis
kept. Neither upstream font declares a Reserved Font Name, so the original
family names stay in use. Each font's license text, with its copyright line, is
in `../licenses/`.

| File | Family | Upstream |
| --- | --- | --- |
| `atkinson-hyperlegible-next-latin-wght-normal.woff2` | Atkinson Hyperlegible Next | [googlefonts/atkinson-hyperlegible-next](https://github.com/googlefonts/atkinson-hyperlegible-next) |
| `atkinson-hyperlegible-mono-latin-wght-normal.woff2` | Atkinson Hyperlegible Mono | [googlefonts/atkinson-hyperlegible-next-mono](https://github.com/googlefonts/atkinson-hyperlegible-next-mono) |

## Where the files come from

Both files are the published files of the Fontsource variable packages, version
`5.3.0` (font version `v7`, license `OFL-1.1`). We checked on 2026-10-11 that
the SHA-256 of each file matches the file served from the package.

| File | Package | SHA-256 |
| --- | --- | --- |
| `atkinson-hyperlegible-next-latin-wght-normal.woff2` | `@fontsource-variable/atkinson-hyperlegible-next@5.3.0` | `18b2a1a39a2fa298b0ba5390aca68462669826c90925656f1c1f6796e0e1bbaf` |
| `atkinson-hyperlegible-mono-latin-wght-normal.woff2` | `@fontsource-variable/atkinson-hyperlegible-mono@5.3.0` | `2706b1ee4f452e744ea91f7e4908cbde9c5d35521bf5ffffc71a382a2de89613` |

Each package serves the file at
`https://cdn.jsdelivr.net/npm/<package>@5.3.0/files/<file>`.

## Obligations for anyone who copies these files

| Do | Why |
| --- | --- |
| Keep `../licenses/OFL-*.txt` next to the fonts, including on a deployed site | OFL condition 2: each copy carries the copyright notice and license |
| Never sell the fonts by themselves | OFL condition 1 |
| Keep the fonts under the OFL | OFL condition 5. The rest of this repository is MIT |
