# Third-party licenses

This project is a fork of **Excalidraw** and redistributes it together with its bundled fonts. Each component is licensed by its respective owner under the terms below. (Nothing here is legal advice — confirm before a public release.)

## Excalidraw

The editor and core packages (`@excalidraw/*`) are © 2020 Excalidraw and licensed under the **MIT License** (see [`LICENSE`](./LICENSE)). MIT permits use, modification, self-hosting, redistribution, and rebranding, provided the copyright + permission notice are retained. The name **"Excalidraw"** and its logo are trademarks of the Excalidraw project and are **not** granted by the MIT license — this fork must ship under its own product name and logo.

## Bundled fonts

Fonts live in `packages/excalidraw/fonts/`. Each retains its upstream license:

| Font | Bundled as | License |
| --- | --- | --- |
| Excalifont | hand-drawn UI default | SIL Open Font License 1.1 |
| Virgil | legacy hand-drawn | SIL Open Font License 1.1 |
| Nunito | normal text | SIL Open Font License 1.1 |
| Lilita One | display | SIL Open Font License 1.1 |
| Assistant | RTL / Hebrew | SIL Open Font License 1.1 |
| Xiaolai (小赖) | CJK | SIL Open Font License 1.1 |
| Cascadia Code | code/mono | SIL Open Font License 1.1 (Microsoft) |
| Liberation Sans | Helvetica-metric fallback | SIL Open Font License 1.1 |
| Comic Shanns Mono | code/mono | see `packages/excalidraw/fonts/ComicShanns/` upstream notice — **confirm before public release** |

"Helvetica" / "Arial" referenced in font stacks are **system** fallbacks — no proprietary font files are redistributed.

## Server & app dependencies

The Python sync server and the JS app depend on third-party packages declared in `server/pyproject.toml` and the root `package.json`; each is governed by its own license as resolved by `uv` / `yarn`. Run a license report (`uv pip licenses` / `license-checker`) before publishing to generate a complete dependency manifest.
