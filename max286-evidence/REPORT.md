# MAX-286 / GitHub #456 acceptance evidence

- Disposable container: slide-max286-77438
- Host port: 49632 (not 3306)
- Database: db_ops_ai_qualification_max286_77438
- Business databases used: no
- Session autocommit before the script: 1
- Cleanup remove code: 0; remaining containers: none

```json
{
  "issue": "https://github.com/max2055/Slide/issues/456",
  "database": "db_ops_ai_qualification_max286_77438",
  "container": "slide-max286-77438",
  "business_databases_used": false,
  "cases": [
    {
      "name": "missing-admin",
      "code": 1,
      "stderr_has_rollback": true,
      "stderr_has_commit": false,
      "stderr_has_ddl": true,
      "message": true,
      "state": {
        "servers": [
          {
            "id": 1,
            "host": "max286-keep.invalid",
            "label": "keep"
          }
        ],
        "alerts": [],
        "analysis": [],
        "jobs": [],
        "counterTable": [
          {
            "table_comment": "Qualification approval execution counter",
            "engine": "InnoDB"
          }
        ],
        "counter": [],
        "users": [
          {
            "id": 1,
            "username": "admin-missing",
            "password_hash": "redacted:64",
            "status": "active"
          },
          {
            "id": 2,
            "username": "user",
            "password_hash": "redacted:64",
            "status": "active"
          }
        ],
        "roles": [],
        "chat": [],
        "messages": []
      }
    },
    {
      "name": "success",
      "code": 0,
      "stdout": "qualification admin prepared",
      "phases": true,
      "state": {
        "servers": [
          {
            "id": 1,
            "host": "max286-keep.invalid",
            "label": "keep"
          },
          {
            "id": 3,
            "host": "qualification-server-rca.invalid",
            "label": "Qualification server RCA"
          }
        ],
        "alerts": [
          {
            "id": 2,
            "server_id": 3,
            "title": "Qualification server RCA browser alert",
            "status": "unread"
          }
        ],
        "analysis": [
          {
            "id": 2,
            "server_id": 3,
            "related_id": 2,
            "cache_key": "alert:2:server:3",
            "session_key": "qualification-server-rca-session"
          }
        ],
        "jobs": [
          {
            "id": "00000000-0000-4000-8000-000000000139",
            "state": "dead_letter",
            "attempts": 5,
            "idempotency_key": "qualification:dead-letter:139",
            "last_error": "qualification delivery failure"
          }
        ],
        "counterTable": [
          {
            "table_comment": "Qualification approval execution counter",
            "engine": "InnoDB"
          }
        ],
        "counter": [
          {
            "id": 1,
            "value": 0
          }
        ],
        "users": [
          {
            "id": 1,
            "username": "admin",
            "password_hash": "redacted:60",
            "status": "active"
          },
          {
            "id": 3,
            "username": "qualification-viewer",
            "password_hash": "redacted:60",
            "status": "active"
          },
          {
            "id": 2,
            "username": "user",
            "password_hash": "redacted:64",
            "status": "active"
          }
        ],
        "roles": [
          {
            "username": "admin",
            "role_name": "admin"
          },
          {
            "username": "qualification-viewer",
            "role_name": "viewer"
          }
        ],
        "chat": [
          {
            "session_id": "qualification-admin-private-session",
            "user_id": 1,
            "title": "qualification private session",
            "message_count": 1
          }
        ],
        "messages": [
          {
            "message_id": "qualification-admin-private-message",
            "content": "private qualification message"
          }
        ]
      }
    },
    {
      "name": "inject-after-rca",
      "code": 1,
      "stderr_has_rollback": true,
      "stderr_has_commit": false,
      "unchanged": true
    },
    {
      "name": "inject-before-commit",
      "code": 1,
      "stderr_has_rollback": true,
      "stderr_has_commit": false,
      "unchanged": true
    },
    {
      "name": "uncommitted-read",
      "observed": {
        "open_trx": 1,
        "same_connection_ids": [
          6
        ],
        "other_connection_ids": [
          3
        ]
      },
      "unchanged": true
    },
    {
      "name": "rerun-success",
      "code": 0,
      "rca_servers": 1,
      "alerts": 1,
      "analysis": 2,
      "keep_server_unchanged": true,
      "state": {
        "servers": [
          {
            "id": 1,
            "host": "max286-keep.invalid",
            "label": "keep"
          },
          {
            "id": 7,
            "host": "qualification-server-rca.invalid",
            "label": "Qualification server RCA"
          }
        ],
        "alerts": [
          {
            "id": 6,
            "server_id": 7,
            "title": "Qualification server RCA browser alert",
            "status": "unread"
          }
        ],
        "analysis": [
          {
            "id": 2,
            "server_id": 3,
            "related_id": 2,
            "cache_key": "alert:2:server:3",
            "session_key": "qualification-server-rca-session"
          },
          {
            "id": 6,
            "server_id": 7,
            "related_id": 6,
            "cache_key": "alert:6:server:7",
            "session_key": "qualification-server-rca-session"
          }
        ],
        "jobs": [
          {
            "id": "00000000-0000-4000-8000-000000000139",
            "state": "dead_letter",
            "attempts": 5,
            "idempotency_key": "qualification:dead-letter:139",
            "last_error": "qualification delivery failure"
          }
        ],
        "counterTable": [
          {
            "table_comment": "Qualification approval execution counter",
            "engine": "InnoDB"
          }
        ],
        "counter": [
          {
            "id": 1,
            "value": 0
          }
        ],
        "users": [
          {
            "id": 1,
            "username": "admin",
            "password_hash": "redacted:60",
            "status": "active"
          },
          {
            "id": 3,
            "username": "qualification-viewer",
            "password_hash": "redacted:60",
            "status": "active"
          },
          {
            "id": 2,
            "username": "user",
            "password_hash": "redacted:64",
            "status": "active"
          }
        ],
        "roles": [
          {
            "username": "admin",
            "role_name": "admin"
          },
          {
            "username": "qualification-viewer",
            "role_name": "viewer"
          }
        ],
        "chat": [
          {
            "session_id": "qualification-admin-private-session",
            "user_id": 1,
            "title": "qualification private session",
            "message_count": 1
          }
        ],
        "messages": [
          {
            "message_id": "qualification-admin-private-message",
            "content": "private qualification message"
          }
        ]
      }
    },
    {
      "name": "unknown-injection",
      "code": 1,
      "touched_database": false,
      "unchanged": true
    }
  ],
  "docker_start_code": 0,
  "port": 49632,
  "init_db_code": 0,
  "session": {
    "autocommit": 1,
    "isolation": "REPEATABLE-READ"
  },
  "engines": [
    {
      "name": "ai_analysis",
      "engine": "InnoDB"
    },
    {
      "name": "alerts",
      "engine": "InnoDB"
    },
    {
      "name": "chat_messages",
      "engine": "InnoDB"
    },
    {
      "name": "chat_sessions",
      "engine": "InnoDB"
    },
    {
      "name": "servers",
      "engine": "InnoDB"
    },
    {
      "name": "users",
      "engine": "InnoDB"
    },
    {
      "name": "workflow_jobs",
      "engine": "InnoDB"
    }
  ],
  "cleanup": {
    "remove_code": 0,
    "remaining_container_ids": "",
    "port": 49632
  }
}
```
