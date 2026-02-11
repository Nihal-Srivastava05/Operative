# Contributing to Operative

Thank you for your interest in contributing to Operative! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md). Please read it before contributing.

## Getting Started

### Prerequisites

- **Node.js**: Version 18 or higher
- **Chrome Canary**: For the latest `window.ai` features (or a browser supporting the Prompt API)
- **Git**: For version control

### Development Setup

1. **Fork the repository** on GitHub

2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/operative.git
   cd operative
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Build the extension**:
   ```bash
   npm run build
   ```

5. **Load the extension in Chrome**:
   - Open `chrome://extensions/`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the `dist` directory

6. **Run the demo MCP server** (optional):
   ```bash
   npm run mcp:demo-server
   ```

## How to Contribute

### Reporting Bugs

Before submitting a bug report:
- Check existing [issues](https://github.com/anthropics/claude-code/issues) to avoid duplicates
- Collect information about the bug (browser version, OS, error logs)

When submitting a bug report:
- Use the bug report template
- Provide clear reproduction steps
- Include error messages from the browser console
- Specify your Chrome version and whether Chrome AI APIs are available

### Suggesting Features

Feature requests are welcome! When suggesting a feature:
- Use the feature request template
- Explain the problem your feature would solve
- Describe your proposed solution
- Consider how it fits into the existing architecture

### Contributing Code

1. **Find or create an issue**
   - Look for issues labeled `good first issue` or `help wanted`
   - Comment on the issue to let others know you're working on it

2. **Create a branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

3. **Make your changes**
   - Follow the coding standards below
   - Write tests for new functionality
   - Update documentation if needed

4. **Run quality checks**
   ```bash
   npm run lint        # Check for linting errors
   npm run typecheck   # Verify TypeScript types
   npm test            # Run tests
   ```

5. **Commit your changes**
   - Write clear, concise commit messages
   - Use conventional commit format when possible:
     - `feat: add new feature`
     - `fix: resolve bug in component`
     - `docs: update documentation`
     - `refactor: restructure code`
     - `test: add tests`

6. **Push and create a pull request**
   ```bash
   git push origin your-branch-name
   ```
   Then open a pull request on GitHub using the PR template.

## Coding Standards

### TypeScript

- Use TypeScript for all new code
- Enable strict mode (`strict: true` in tsconfig)
- Prefer explicit types over `any`
- Use interfaces for object shapes

### Code Style

- Follow the existing code style in the project
- Use ESLint and Prettier for formatting
- Run `npm run lint` before committing

### File Organization

```
src/
├── components/     # React UI components
├── services/       # Core business logic
│   ├── ai/         # Chrome AI integration
│   ├── mcp/        # MCP client/server implementations
│   ├── orchestrator/   # Agent orchestration
│   └── knowledge/  # Knowledge management
├── store/          # Database and state management
└── types/          # TypeScript type definitions
```

### Testing

- Write tests for new functionality using Vitest
- Place test files alongside source files with `.test.ts` extension
- Run tests with `npm test`
- Aim for meaningful test coverage, not just high numbers

### React Components

- Use functional components with hooks
- Keep components focused and single-purpose
- Use TypeScript for prop types

## Project Architecture

Operative follows a service-oriented architecture:

- **Orchestrator**: Routes user queries to appropriate agents
- **Agent Runner**: Executes agent logic and manages conversations
- **MCP Client**: Connects to MCP servers for external tools
- **Chrome AI Service**: Interfaces with `window.ai.languageModel`

See [Architecture Overview](docs/architecture.md) for detailed information.

## Pull Request Guidelines

### Before Submitting

- [ ] Code follows the project's coding standards
- [ ] All tests pass (`npm test`)
- [ ] Linting passes (`npm run lint`)
- [ ] Type checking passes (`npm run typecheck`)
- [ ] Documentation is updated if needed
- [ ] Commit messages are clear and descriptive

### Review Process

1. A maintainer will review your PR
2. Address any requested changes
3. Once approved, a maintainer will merge your PR

### What We Look For

- Code quality and readability
- Test coverage for new features
- Documentation for public APIs
- Adherence to existing patterns
- No breaking changes without discussion

## Development Tips

### Debugging

- **Extension Console**: Right-click the extension popup > Inspect
- **Background Script**: `chrome://extensions` > Operative > "service worker"
- **MCP Server**: Check the terminal running `npm run mcp:demo-server`

### Adding New Tools

To add tools to the MCP demo server, see the [Developer Guide](docs/developer_guide.md#adding-new-tools).

### Creating Agents

Agents can be created through the UI or programmatically. See the [Developer Guide](docs/developer_guide.md#creating-a-new-agent) for details.

## Getting Help

- Check the [documentation](docs/)
- Open a [discussion](https://github.com/anthropics/claude-code/discussions) for questions
- Join community discussions for support

## Recognition

Contributors will be recognized in the project. Thank you for helping make Operative better!

## License

By contributing to Operative, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
