You eliminated three classes of unnecessary work:

- `memo` skips a component when its props are unchanged.
- `useMemo` caches an expensive computation between renders.
- `useCallback` keeps a function reference stable so `memo` can do its job.

Optional follow-up: enable the React Compiler in `vite.config.js`
(`babel-plugin-react-compiler` is already installed) and see how many of these
optimizations it applies for you.
