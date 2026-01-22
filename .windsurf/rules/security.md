# Security Rules

## Authentication & Authorization

### SSO Authentication
- Use Microsoft Teams SSO for user authentication
- Implement proper token validation
- Set appropriate token expiration times
- Store authentication tokens securely
- Never expose tokens in client-side code

### Authorization
- Implement role-based access control
- Verify user permissions for each protected action
- Apply principle of least privilege
- Document access control policies

## Bitcoin/Lightning Network Security

### Wallet Management
- Secure storage of wallet credentials
- Use environment variables for sensitive data
- Implement transaction limits
- Apply proper validation for all payment operations
- Keep Lightning Node software updated

### LNbits Integration
- Use API keys with minimal required permissions
- Rotate API keys regularly
- Validate all inputs from LNbits
- Implement proper error handling for API failures
- Log all transactions for audit purposes

## Data Protection

### User Data
- Encrypt sensitive user data at rest
- Use HTTPS for all communications
- Implement proper data retention policies
- Apply data minimization principles
- Obtain consent for data collection

### Transaction Data
- Encrypt all transaction records
- Implement access controls for transaction history
- Audit trail for all zap transactions
- Secure backup of transaction data

## Vulnerability Management

### Code Security
- Perform security code reviews
- Use static analysis tools
- Avoid hardcoded secrets
- Update dependencies regularly
- Follow OWASP security guidelines

### Dependency Management
- Regular security audits of dependencies
- Use dependency scanning tools
- Define a process for dependency updates
- Document known vulnerabilities and mitigations

## API Security

### Input Validation
- Validate all user inputs
- Implement proper error handling
- Rate limit API endpoints
- Prevent common attacks (XSS, CSRF, injection)

### Secure API Design
- Use API tokens for authentication
- Implement proper CORS policies
- Log all API access
- Document API security requirements

## Incident Response

### Monitoring
- Log security events
- Implement alerting for suspicious activities
- Regular security reviews
- Document security incident response procedures

### Response Plan
- Define roles and responsibilities
- Document containment procedures
- Establish communication protocols
- Implement recovery procedures
