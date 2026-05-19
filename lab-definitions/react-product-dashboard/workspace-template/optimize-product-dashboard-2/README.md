---
difficulty: 1
tags: react
chapter: "Chapter 2: Rendering Optimization"
training: true
---

# Optimize Product Dashboard

## Challenge Description

Time to optimize a React application with performance opportunities! 🎯 You'll be working with memoization techniques and performance monitoring to eliminate unnecessary re-renders in a product dashboard. This challenge focuses on understanding React's performance optimization patterns so you can confidently tackle bottlenecks in your future projects.

Your task is to identify and apply performance optimizations to a product dashboard that displays products with filtering, cart functionality, and render tracking.

## Requirements

- Fix the unnecessary re-renders in the `CartButton` component. The `CartButton` re-renders every time items are added to cart or filters change, even though its display only depends on the cart items count.
- Fix the expensive filtering operations in `ProductList`. The filtering logic runs on every render, including when adding items to cart, even when the products array and filter value haven't changed.
- Fix the `ProductCard` components re-rendering when items are added to cart. Each `ProductCard` re-renders when any item is added to cart, even when their individual product data hasn't changed.

> 💡 TIP: First, try React Compiler! Add React Compiler to your Vite config following the [React Compiler installation docs](https://react.dev/learn/react-compiler/installation). Did it fix all the re-renders? You can see its "memo" badges in the React DevTools Components panel. Add manual optimizations only if needed.
>
> 💡 TIP: Use the React DevTools Profiler to see how rendering occurs. Record a profiling session while interacting with the app to visualize which components are re-rendering and why.
>
> 💡 NOTE: In the real world, you probably wouldn't optimize manually this way unless the app has a performance problem. Manual memoization with `memo()`, `useMemo()`, and `useCallback()` can make code harder to read and maintain. This exercise is for learning the concepts behind React optimization.

## Other Considerations

- TailwindCSS is preinstalled with the default config. It might be helpful for you, if you want to have some styles. (Not obligatory)
- 👀 Don't peek at the solution until you've solved the exercise yourself or exhausted your resources. Challenging yourself will best prepare you for the exam.

## Example of Finished App

This is an example of what the functionality should look like for the completed exercise. If you'd like to mimic this style, feel free to do so, but it is not required.

![Screenshot of the finished app](https://api.certificates.dev/repositories/assets/UmVhY3QtQ2VydGlmaWNhdGlvbi9sMy10cmFpbmluZy1jb2RlLWNoYWxsZW5nZS1jaGFwdGVyLTIvc2NyZWVuc2hvdC5naWY=)
