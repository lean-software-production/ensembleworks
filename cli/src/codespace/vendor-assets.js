// Runtime-only module (typed by vendor-assets.d.ts): `with { type: 'file' }`
// makes `bun build --compile` embed the vendored devcontainers-cli bundle in
// the single ew binary (design §2.2 approach B). At runtime each import is a
// PATH string — the real cli/vendor/… file in dev, the embedded /$bunfs/…
// blob when compiled (readable via Bun.file, not on the real FS — which is
// exactly how mode is detected). Kept as .js so tsc never type-checks the
// 1.7MB vendor bundle.
import devcontainerEntry from '../../vendor/devcontainers-cli/devcontainer.js' with { type: 'file' }
import specCliBundle from '../../vendor/devcontainers-cli/dist/spec-node/devContainersSpecCLI.js' with { type: 'file' }

export { devcontainerEntry, specCliBundle }
