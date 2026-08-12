# Pi Show Me

Always-on visual-explanation policy for [Pi](https://pi.dev). It injects the bundled Show Me instructions into each agent turn, shows `[SHOW-ME]` in the footer while active, and provides `/show-me on|off|status` for per-session control.

The bundled skill is adapted from [humanlayer/skills `plugins/show-me`](https://github.com/humanlayer/skills/tree/main/plugins/show-me), copyright Humanlayer contributors, under the [MIT License](https://github.com/humanlayer/skills/blob/main/LICENSE). `disable-model-invocation: true` keeps it available as `/skill:show-me` while avoiding automatic model-triggered loading on top of the always-on extension.
