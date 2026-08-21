VIEWCODER GAME ICON LIBRARY
===========================

This folder contains 327 game UI icons already extracted and ready to use.
Users do not need to unzip any of the original icon packs.

Categories
----------
- candy-and-items
- currency
- food-and-desserts
- food-and-farming
- halloween
- lucky-boxes
- materials-and-resources

How ViewCoder uses the library
------------------------------
1. The AI decides whether an icon improves a UI control; an explicit icon request
   is always honored.
2. ViewCoder tries real generation first and searches the library for a genuine
   semantic fallback plus a separate visual style reference.
3. A style-only reference guides simplicity, lighting, texture, material, and
   overall look. Its object is never substituted for the requested object.
4. Text-only AIs provide simple ellipse, rounded-rectangle, polygon, and capsule
   layers in icon_spec. ViewCoder rasterizes them locally into a transparent PNG.
5. Unless the user requests another style, generated icons use the library-inspired
   soft top-left lighting, gentle highlights, subtle texture, rounded forms, clean
   materials, and controlled colors.
6. After 12 failures from a genuine 2D generator, ViewCoder may use a bundled icon
   only when it semantically matches. Otherwise it renders the requested icon_spec.

The machine-readable index is catalog.json. The local bridge can expose a selected
or locally rendered icon temporarily on 127.0.0.1 so a live Roblox Studio
upload_image command can receive it. The AI must verify the returned asset/content
ID before claiming success.

Rights
------
These packs were supplied by the user and contained no license documents when
they were added. Read ../GAME-ICON-LIBRARY-NOTICE.txt before redistribution or
commercial use.

