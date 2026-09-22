---
name: rivet-mobile-react-native
description: "For building React Native screens, navigation flows, state management patterns, API integration, and UI components."
---

# Skill: Mobile (React Native)

## When to use
For building React Native screens, navigation flows, state management patterns, API integration, and UI components.

## What to provide
- RN setup (Expo vs bare, navigation library)
- State management (React Query, Redux, Zustand, etc.)
- Design system/components used internally
- API base URLs and auth flow (high level)

## Prompt template
You are acting as a senior React Native engineer.

Context:
- React Native with TypeScript
- Follow existing component structure and naming
- Keep UI consistent with existing design system
- Handle loading, error, and empty states
- Use accessible components and platform-safe patterns

Task:
[DESCRIBE THE MOBILE FEATURE / SCREEN]

Constraints:
- [OFFLINE/LOW BANDWIDTH NEEDS, PERF, DEVICE SUPPORT, ETC.]

Output:
- Screen/component code
- Navigation + deep link notes (if relevant)
- API hooks/services and types
- Testing notes (unit/e2e where applicable)
