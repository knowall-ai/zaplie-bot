---
trigger: manual
---

# Code Style Rules

## General Guidelines

-We prefer simple, elegant and concise coding solutions.
-We generally prefer Microsoft solutions and open-source solutions.
-We use kebab case for file and directory names.
-We use PascalCase for class names and camelCase for variables.

### File Structure
- Use consistent file extensions (.tsx for TypeScript React components)
- Place related files in logical directories
- Keep files under 400 lines

### Naming Conventions
- Components: PascalCase (e.g., UserProfile)
- Functions: camelCase (e.g., getUserProfile)
- Constants: UPPER_SNAKE_CASE (e.g., API_ENDPOINT)
- Variables: camelCase (e.g., userProfile)

### React Components
- Use functional components with hooks
- Export components as default
- Use proper prop types
- Keep components pure and reusable

### TypeScript
- Use strict mode
- Avoid any type
- Use interfaces for complex types
- Use enums for fixed value sets

### Formatting
- 2 spaces indentation
- Single quotes
- Trailing commas
- Maximum line length: 80 characters

### Imports
- Group related imports
- Alphabetize imports within groups
- Use named exports when possible

### Error Handling
- Always handle API errors
- Use proper error boundaries
- Log errors appropriately
- Provide user-friendly error messages

### Performance
- Memoize expensive computations
- Use proper component optimization
- Avoid unnecessary re-renders
- Implement proper cleanup

### Testing
- Write unit tests for components
- Test edge cases
- Mock external dependencies
- Keep tests independent

### Documentation
- Document complex logic
- Add JSDoc comments for public APIs
- Keep READMEs up to date
- Document state management
