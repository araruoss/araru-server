# Central de configurações de segurança

As configurações editáveis da área administrativa são armazenadas como overrides tipados em `app_settings`. O registro em `server/services/settingsRegistry.js` é a fonte do schema, dos defaults, dos limites e da classificação operacional.

## Precedência e aplicação

O valor efetivo segue `PostgreSQL override > default do registro`. Valores de implantação, como URL do Redis, origens CORS, cookies Secure e proxy confiável, continuam vindo do ambiente e aparecem como somente leitura na UI.

Cada item informa se é aplicado em runtime ou exige reinício. Alterações de duração de sessão afetam novas sessões depois do reinício; políticas de senha, conteúdo externo e rate limit são consultadas dinamicamente.

## API administrativa

- `GET /api/v1/admin/settings/schema?category=security`: schema e capacidades.
- `GET /api/v1/admin/settings/security`: valores configurados, efetivos, defaults e versão.
- `PATCH /api/v1/admin/settings/security`: salva overrides tipados e registra auditoria.
- `POST /api/v1/admin/settings/reset`: remove overrides e restaura os defaults do registro.

As escritas aceitam `expectedVersion`. Uma versão diferente retorna `409 SETTINGS_CONFLICT`, evitando que um administrador sobrescreva alterações concorrentes. Auditorias são gravadas na mesma transação e não incluem senhas, tokens ou segredos.

Rate limiting usa Redis quando configurado, permitindo contagem compartilhada entre instâncias. Sem Redis, o fallback em memória é local ao processo e deve ser tratado como configuração inadequada para escala horizontal.
