# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

## Gemini moderation

The `/api/moderate` endpoint runs as a Vercel serverless function. Set `GEMINI_API_KEY` in the Vercel project's Environment Variables; do not expose it through a `VITE_` variable. Redeploy after setting the variable. Moderation errors prevent the story paragraph from being published through the app. The endpoint is publicly callable, and client-side moderation does not prevent direct Firestore writes; add rate limiting and enforce write rules in Firebase before relying on this as an abuse-prevention boundary.

## QStash turn timer

The active writer's three-hour deadline is scheduled by `/api/start-timer` and handled by the signature-verified `/api/pass-baton` callback. On timeout, the active queue entry is marked `timed_out`, and the next waiting writer's timer is scheduled. No email provider is configured.

Set these server-side Vercel Environment Variables, then redeploy:

- `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY` from the Upstash QStash console.
- `FIREBASE_SERVICE_ACCOUNT_JSON`, the complete Firebase service-account JSON with access to the app's Firestore project. Keep this secret and never use a `VITE_` prefix.
- `APP_BASE_URL`, the HTTPS origin of the deployed Vercel app (for example, `https://your-app.vercel.app`).

Firebase client authentication must use the same Firebase project as the service account. The browser starts a timer when its authenticated user becomes the active writer; the QStash callback advances the queue even if that writer closes the app.

Firebase Admin bypasses Firestore Security Rules. Configure rules so clients cannot write timer metadata or mark another user's queue entry timed out; otherwise direct Firestore writes can bypass the timer workflow.
