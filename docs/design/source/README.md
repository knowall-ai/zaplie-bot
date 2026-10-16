# Design mockups: source

The nine images in `docs/design/` (shown in the README's Design section) are rendered from `design.html`. They're mockups of the product vision, not screenshots of the running app.

- **Zaplie** uses his profile picture, `assets/zaplie-profile.jpg`: a copy of `images/zaplie-profile.jpg` from his character kit (added to `assets/agent/` by [PR 483](https://github.com/knowall-ai/zaplie-bot/pull/483)).
- **People** are demo names (Jack Mallers, Michael Saylor, Jack Dorsey, Satoshi Nakamoto, Samson Mow), shown with initials, not photos.
- **Agents** are KnowAll's agents (Sallie, Poppie, Archie, Teddie, Preppie), with their portraits from the KnowAll website.
- **Organisations** are Microsoft's standard demo names (Fabrikam, Contoso, Adatum, Alpine Ski House, Northwind Traders).
- The product, bounty and raiser photos in `assets/` are cropped from the original Figma designs.

## Render

Open `design.html?s=<screen>` at 1440x810. The screens are `chat`, `feed`, `automations`, `rewards`, `bounties`, `raisers`, `users`, `wallet` and `projects`. To render them all at 2x with headless Chrome:

```bash
cd docs/design/source
for s in chat feed automations rewards bounties raisers users wallet projects; do
  google-chrome --headless=new --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1440,810 --allow-file-access-from-files --virtual-time-budget=3000 \
    --screenshot="../$s.png" "file://$PWD/design.html?s=$s"
done
```

Fonts: the page uses Segoe UI, as Teams does. On Linux it falls back to the system sans-serif, so render on Windows (or install Segoe UI) to match the committed images.
