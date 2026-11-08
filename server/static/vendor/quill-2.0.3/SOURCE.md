# Quill 2.0.3

Served from here rather than a CDN, so no third party can change the code
that runs in the journal page (where it could read entries and the password).

- From: npm package `quill@2.0.3` (`dist/quill.js`, `dist/quill.snow.css`, `LICENSE`)
- npm integrity: `sha512-xEYQBqfYx/sfb33VJiKnSJp8ehloavImQ2A6564GAbqG55PGw1dAWUn1MUbQB62t0azawUS2CZZhWCjO8gRvTw==`

To upgrade: `npm pack quill@<version>` (npm verifies the integrity), copy the
same three files into a new `quill-<version>/` folder, point
`templates/app.html` at it, and test the editor before removing this one.
