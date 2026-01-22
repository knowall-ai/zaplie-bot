# Performance Rules

## Frontend Performance

### Component Optimization
- Use React.memo for expensive components
- Implement useMemo for heavy calculations
- Avoid unnecessary re-renders
- Use useCallback for event handlers passed to child components
- Optimize state updates with batch processing

### Bundle Size
- Implement code splitting
- Lazy load components when appropriate
- Set up proper tree shaking
- Minimize third-party dependencies
- Analyze bundle size regularly

### Rendering Performance
- Keep render functions pure and efficient
- Avoid inline functions and object literals in JSX
- Use virtualization for long lists
- Optimize component hierarchies
- Minimize DOM mutations

## API Performance

### Request Optimization
- Batch API calls when possible
- Implement data pagination
- Use GraphQL for complex data requirements
- Optimize payload size
- Cache responses appropriately

### Lightning Network Integration
- Implement proper caching for wallet balances
- Optimize transaction validation
- Use efficient lightning node configurations
- Batch transaction processing where possible

## Caching Strategies

### Client-Side Caching
- Use React Query for data fetching and caching
- Implement local storage for user preferences
- Set up proper cache invalidation
- Use memory caching for frequently accessed data

### Server-Side Caching
- Cache API responses
- Implement Redis for shared caching
- Set up proper TTL for cached items
- Cache external API responses (LNbits, etc.)

## Network Optimization

### Asset Delivery
- Use CDN for static assets
- Implement proper compression
- Set up HTTP/2 or HTTP/3
- Optimize asset size
- Use browser caching

### API Communication
- Minimize payload size
- Use compression for API responses
- Implement connection pooling
- Optimize request/response cycles

## Performance Monitoring

### Metrics Collection
- Track core web vitals
- Monitor API response times
- Track component render times
- Set up real user monitoring
- Implement synthetic monitoring

### Performance Budgets
- Set maximum bundle size
- Define target load times
- Establish memory usage limits
- Monitor time to interactive
- Track first contentful paint

## Performance Testing

### Load Testing
- Test application under expected load
- Identify performance bottlenecks
- Establish baseline performance metrics
- Test scaling capabilities

### Optimization Process
- Regular performance audits
- Implement performance regression testing
- Document optimization strategies
- Prioritize high-impact optimizations
