export const SERVER_ENVIRONMENT_OPTIONS = [
  { value: 'development', label: '开发环境' },
  { value: 'testing', label: '测试环境' },
  { value: 'staging', label: '预发布环境' },
  { value: 'production', label: '生产环境' },
  { value: 'unknown', label: '未标注环境' },
] as const;
