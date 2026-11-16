# Flatpak packaging

Builds the Blinko desktop app as a Flatpak, published as a `.flatpak` bundle on
every release by the `publish-flatpak` job in
[`app-release.yml`](../.github/workflows/app-release.yml).

## Why

The AppImage bundles its own copy of WebKitGTK, taken from the `ubuntu-22.04`
runner that builds it. WebKitGTK talks directly to EGL/Mesa, so a bundled copy is
pinned to the graphics stack of the build machine. On a host with a newer Mesa,
WebKit's renderer cannot initialise EGL:

```
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

The window opens but stays blank white. The binary's `RUNPATH` is
`$ORIGIN/../lib`, so the bundled copy wins even with `LD_LIBRARY_PATH` unset,
and the usual escape hatches (`WEBKIT_DISABLE_DMABUF_RENDERER`,
`WEBKIT_DISABLE_COMPOSITING_MODE`, `GDK_BACKEND=x11`) have no effect.

Flatpak fixes this structurally: `org.gnome.Platform` ships WebKitGTK **and** the
matching GL stack as one unit, so the two can never disagree.

## What gets built

The manifest repackages the `.deb` from the same release rather than rebuilding
from source — a Tauri build needs network access for cargo/bun, which
flatpak-builder's sandbox does not allow. The `.deb` is just the binary, a
desktop entry and icons, so unpacking it is cheap and keeps the Flatpak
byte-identical to the `.deb` we already ship.

A few libraries are built because the runtime does not carry them:

| Module | Why |
| --- | --- |
| `intltool` | Build-time only: `libdbusmenu`'s configure requires it and the SDK does not ship it. Cleaned out of the final app. |
| `libdbusmenu` | Dependency of libayatana-appindicator. |
| `ayatana-ido` | Dependency of libayatana-indicator. |
| `libayatana-indicator` | Dependency of libayatana-appindicator. |
| `libayatana-appindicator` | System tray. Blinko `dlopen()`s `libayatana-appindicator3.so.1`; without it the app runs but has no tray icon. |
| `xdotool` (3.x) | Provides `libxdo.so.3`, a hard `DT_NEEDED` of the binary. Pinned to 3.x because 4.x installs `libxdo.so.4`. |

`libdbusmenu` needs one workaround: it declares the `HAVE_VALGRIND` automake
conditional inside its `--enable-tests` block, so building with `--disable-tests`
leaves the conditional undefined and configure aborts. The manifest passes
`HAVE_VALGRIND_TRUE`/`HAVE_VALGRIND_FALSE` directly to work around it.

Everything else — GTK 3, WebKitGTK 4.1, libsoup 3, cairo, gdk-pixbuf — comes
from the runtime.

## Building locally

```bash
./flatpak/build-local.sh          # latest published .deb
./flatpak/build-local.sh 1.8.8    # a specific release
BLINKO_DEB=app/src-tauri/target/release/bundle/deb/Blinko_1.8.8_amd64.deb \
  ./flatpak/build-local.sh        # a .deb you just built
```

Then:

```bash
flatpak install --user -y Blinko_local_x86_64.flatpak
flatpak run space.blinko.Blinko
```

Verified by installing the bundle this workflow produces on Arch Linux (Mesa
26.1, AMD Radeon 840M, KDE Wayland) — the same machine where the AppImage shows
the blank white window. Against `org.gnome.Platform//50` the app renders, the
system tray initialises, and no EGL error appears.

## Mixed-DPI: window buttons may not respond

On a multi-monitor setup where the screens have **different scale factors**
(e.g. an external display at 1.0 next to a laptop panel at 1.35), the window's
titlebar buttons can be drawn in one place while their clickable region sits in
another, so close/minimize/maximize appear dead. The window is fine otherwise
and the compositor can still minimize or close it programmatically.

This is a GTK3/WebKitGTK-under-Wayland scaling issue rather than anything
specific to Flatpak — the same binary shows it outside the sandbox — so the
manifest deliberately does **not** force XWayland on everyone. Running under
XWayland fixes it, at the cost of blurrier rendering on HiDPI screens, so it is
left as an opt-in for affected users:

```bash
flatpak override --user --socket=x11 --nosocket=wayland \
  --env=GDK_BACKEND=x11 space.blinko.Blinko
```

Undo with:

```bash
flatpak override --user --reset space.blinko.Blinko
```

## Known limitations

- **The built-in updater does not work inside Flatpak.** A sandboxed app cannot
  rewrite `/app`, so the Tauri updater will fail if it tries to self-update.
  Flatpak users update through `flatpak update`. Gating the update check behind
  an environment variable set in `finish-args` would be a good follow-up.
- **x86_64 only**, matching the Linux `.deb` the release pipeline produces.
- **Not yet on Flathub.** This job produces a downloadable bundle. A Flathub
  submission additionally needs `<screenshots>` in
  `space.blinko.Blinko.metainfo.xml` and a separate `flathub/space.blinko.Blinko`
  repository.

## App ID

`space.blinko.Blinko`, derived from the project's own domain (`blinko.space`).
This intentionally differs from the Tauri identifier `com.blinko.app`, which is
not a domain the project controls and so would not be accepted by Flathub. The
Tauri identifier still determines the app's data directory inside the sandbox.
