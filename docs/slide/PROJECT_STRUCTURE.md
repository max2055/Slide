# Slide Project Structure

## Overview

Slide is an AI-Powered Database Operations Platform built on top of OpenClaw's Control UI architecture.

## Directory Structure

```
39-dbops/
├── apps/
│   └── db-ops-api/          # Backend API (Fastify + TypeScript)
│       ├── server.ts        # Entry point
│       ├── init-db.ts       # Database initialization
│       ├── sql/
│       │   └── schema.sql   # Database schema
│       └── src/
│           ├── db-connection.ts           # System DB connection
│           ├── auth-database-service.ts   # Authentication
│           ├── instance-database-service.ts # Instance config
│           ├── llm-database-service.ts    # LLM config
│           ├── alert-database-service.ts  # Alerts
│           ├── metrics-database-service.ts # Metrics
│           ├── database-service.ts        # DB pool management
│           └── llm-service.ts             # LLM provider mgmt
├── frontend/
│   ├── src/
│   │   ├── openclaw/        # OpenClaw Core Layer
│   │   │   └── ui/
│   │   │       ├── app.ts              # Main app component
│   │   │       ├── gateway.ts          # WebSocket client
│   │   │       ├── app-lifecycle.ts    # Lifecycle hooks
│   │   │       ├── navigation.ts       # Tab navigation
│   │   │       ├── storage.ts          # Local storage
│   │   │       ├── theme.ts            # Theme system
│   │   │       ├── i18n/               # Internationalization
│   │   │       ├── controllers/        # State controllers
│   │   │       └── views/              # UI views
│   │   │
│   │   ├── slide/           # Slide Business Layer
│   │   │   ├── adapters/
│   │   │   │   └── gateway-adapter.ts  # RPC to REST adapter
│   │   │   ├── services/
│   │   │   │   └── index.ts            # Business services
│   │   │   ├── types/
│   │   │   │   └── index.ts            # Business types
│   │   │   ├── pages/
│   │   │   │   └── index.ts            # Slide pages
│   │   │   └── index.ts                # Module entry
│   │   │
│   │   ├── api/             # API Client
│   │   │   ├── index.ts     # HTTP client
│   │   │   └── database.ts  # Database API calls
│   │   │
│   │   ├── pages/           # Existing Slide pages
│   │   │   ├── DashboardPage.ts
│   │   │   ├── InstancesPage.ts
│   │   │   ├── AlertsPage.ts
│   │   │   ├── ChatPage.ts
│   │   │   └── ...
│   │   │
│   │   ├── components/      # Shared components
│   │   ├── utils/           # Utilities
│   │   ├── styles/          # Global styles
│   │   └── main.ts          # Entry point
│   │
│   ├── package.json
│   └── vite.config.ts
│
├── openclaw_source_code/    # OpenClaw Fork (Git repo)
│   ├── ui/src/ui/           # Control UI core
│   ├── src/gateway/         # Gateway protocol
│   ├── src/plugin-sdk/      # Plugin SDK
│   ├── SLIDE_FORK.md        # Fork documentation
│   └── .git/
│
├── packages/                # Shared packages
├── extensions/              # Extension plugins (optional)
├── scripts/
│   └── sync-openclaw.sh     # Sync script (legacy)
├── CLAUDE.md                # Project instructions
└── README.md                # Project README
```

## Architecture Layers

### 1. Core Layer (openclaw/)

**Purpose**: Provides foundational UI framework and communication protocol

**Key Components**:
- `OpenClawApp` - Main Lit component with lifecycle management
- `GatewayBrowserClient` - WebSocket client with auto-reconnect
- Host-based state management pattern
- Theme system and i18n

**Files**: 124 TypeScript files in `frontend/src/openclaw/ui/`

### 2. Business Layer (slide/)

**Purpose**: Implements Slide-specific business logic

**Services**:
- `DatabaseService` - Instance management, health, metrics
- `AlertService` - Alert listing and acknowledgment
- `LLMService` - LLM configuration and testing
- `ChatService` - AI-powered chat operations
- `SkillsService` - Skill execution
- `ReportsService` - Report generation
- `UserService` - User management
- `AuthService` - Authentication

**Adapter**:
- `SlideGatewayAdapter` - Maps OpenClaw RPC methods to Slide REST APIs

### 3. Application Layer (pages/)

**Purpose**: User-facing pages and components

**Pages**:
- DashboardPage - Overview with stats and charts
- InstancesPage - Database instance management
- AlertsPage - Alert monitoring
- ChatPage - AI chat interface
- LLMSettingsPage - LLM configuration
- ReportsPage - Report management
- UserManagementPage - User administration

## Data Flow

```
User Action → OpenClaw App → Gateway Adapter → Slide API → Backend
                ↓                                    ↓
            Lit Components                    Fastify Server
                ↓                                    ↓
            OpenClaw Core  ←  Gateway Protocol  ←  Database
```

## RPC Method Mapping

| OpenClaw RPC Method | Slide API Endpoint |
|---------------------|-------------------|
| `database:list` | GET `/api/database/instances` |
| `database:get` | GET `/api/database/instance/:id` |
| `health:summary` | GET `/api/health/summary` |
| `health:history` | GET `/api/health/history` |
| `metrics:query` | GET `/api/metrics/query` |
| `slow-queries:list` | GET `/api/slow-queries` |
| `alerts:list` | GET `/api/alerts` |
| `alerts:acknowledge` | POST `/api/alerts/:id/acknowledge` |
| `llm:list` | GET `/api/llm/configs` |
| `llm:test` | POST `/api/llm/test` |
| `chat:send` | POST `/api/chat/send` |
| `chat:history` | GET `/api/chat/history` |
| `skills:list` | GET `/api/skills` |
| `skills:execute` | POST `/api/skills/:id/execute` |
| `auth:login` | POST `/api/auth/login` |
| `auth:logout` | POST `/api/auth/logout` |
| `auth:me` | GET `/api/auth/me` |

## Development Workflow

### Starting Development

```bash
# Terminal 1 - Backend
cd apps/db-ops-api
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
```

### Adding New Features

1. **Define types** in `slide/types/index.ts`
2. **Add service methods** in `slide/services/index.ts`
3. **Register RPC handler** in `slide/adapters/gateway-adapter.ts`
4. **Create/update page component** in `frontend/src/pages/`
5. **Update navigation** in `frontend/src/openclaw/ui/navigation.ts`

### Syncing with OpenClaw Upstream

```bash
cd openclaw_source_code
git fetch upstream
git merge upstream/main
# Resolve conflicts
git commit
```

## Key Decisions

1. **Fork Mode**: Maintaining a custom branch of OpenClaw rather than copying files
2. **Three-Layer Architecture**: Clear separation between core, business, and application
3. **Gateway Adapter Pattern**: Translates RPC to REST for clean integration
4. **Host-Based State**: Follows OpenClaw pattern for state management
5. **TypeScript**: Full type safety across all layers

## Migration Notes

- Existing pages in `frontend/src/pages/` are preserved
- API client in `frontend/src/api/` continues to work
- New services layer provides cleaner abstraction
- OpenClaw core handles lifecycle and connectivity
- Gateway protocol provides automatic reconnection
