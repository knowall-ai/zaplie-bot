# Testing Rules

## Test Coverage
- Minimum 80% test coverage
- 100% coverage for critical paths
- Test all error cases
- Test all user flows

## Test Types
- Unit tests for components
- Integration tests for API calls
- E2E tests for user flows
- Performance tests for critical paths

## Test Structure
- One test file per component
- Group related tests
- Clear test descriptions
- Isolated test environments

### Unit Tests
- Test component props
- Test state changes
- Test event handlers
- Test rendering

### Integration Tests
- Test API endpoints
- Test data flow
- Test error handling
- Test authentication

### E2E Tests
- Test complete flows
- Test user interactions
- Test error states
- Test edge cases

## Automated UI Testing
- Use Playwright for all UI automation tests
- Create test scripts for critical user journeys
- Test across multiple browsers (Chrome, Firefox, Edge)
- Implement visual regression testing
- Record videos of failed tests
- Use Page Object Model pattern
- Implement CI/CD pipeline integration
- Run tests in both headless and headed modes
- Create reusable test fixtures
- Implement retry logic for flaky tests

## Best Practices
- Write tests before code
- Keep tests independent
- Mock external dependencies
- Use proper test data
- Clean up after tests

## Performance Testing
- Test response times
- Test memory usage
- Test under load
- Test error recovery

## Security Testing
- Test authentication
- Test authorization
- Test data validation
- Test error handling

## Documentation
- Document test setup
- Document test data
- Document test assumptions
- Document test limitations
