# Spec Técnica: ClickUp DevTimer (VS Code Extension)

**Versão da Spec:** 1.2.0

**Status:** Aprovada para Desenvolvimento (escopo v1 fechado)

**Nome do Produto:** ClickUp DevTimer

**Marketplace Title:** `ClickUp DevTimer - Smart Time Tracker for ClickUp`

**Publisher:** andradevander · **Licença:** MIT · **Distribuição:** VS Code Marketplace + Open VSX

---

## 0. Changelog da Spec

| Versão | Mudanças |
| --- | --- |
| 1.1.0 | Versão inicial. |
| 1.2.0 | Endpoint novo de time entries (`/team/{id}/time_entries`). Uma entrada por trecho contínuo. Persistência em arquivo JSON com coordenação entre janelas. Regras de inatividade detalhadas. Detecção de task pela branch Git. Fila offline com sync automático. Arredondamento configurável. Sugestão de mudança de status. i18n (en + pt-BR). Stack de engenharia e CI/CD definidos. |

---

## 1. Visão Geral do Produto

O **ClickUp DevTimer** é uma extensão para Visual Studio Code que tira o atrito do registro de horas (time tracking) no ClickUp. O desenvolvedor vê, seleciona e controla o tempo das suas tarefas direto da barra de status do VS Code. A precisão vem da detecção automática de inatividade, e o tempo é sincronizado direto com a API do ClickUp.

### 1.1 Diferenciais Competitivos

* **Foco no Dev Flow:** operação 100% via teclado/Status Bar, sem precisar abrir a web.
* **Detecção Inteligente de Inatividade:** pausa automática quando o dev se afasta e retomada automática quando ele volta. O tempo ocioso é descontado.
* **Integração com Git:** detecta a task pelo nome da branch e sugere iniciar o timer.
* **Resiliência:** estado persistido em arquivo local, recuperação de crash e fila offline com sync automático.
* **Multi-janela:** um único timer coordenado entre todas as janelas abertas do VS Code. Atividade em qualquer janela conta.
* **Filtro Inteligente de Tasks:** mostra primeiro as tarefas atribuídas ao usuário em status ativos (configuráveis), depois as recentes e as demais.

### 1.2 Escopo da v1

Tudo descrito nesta spec faz parte da v1. Itens fora de escopo estão na seção 11.

---

## 2. Arquitetura do Sistema

```
+--------------------------------------------------------------------------------+
|                               VS Code Extension                                |
|                                                                                |
|  +--------------+     +----------------+     +-----------------+               |
|  | StatusBarUI  | <-> |  StateManager  | <-> | ActivityWatcher |               |
|  | QuickPickUI  |     |  (core puro)   |     +-----------------+               |
|  +--------------+     +----------------+     +-----------------+               |
|                         ^    ^      ^        | GitIntegration  |               |
|                         |    |      +------> +-----------------+               |
|                         |    v                                                 |
|                         |  +-------------------+    +------------------+       |
|                         |  | WindowCoordinator | <->|   StorageService  | --> ~/.clickup-devtimer/*.json
|                         |  +-------------------+    +------------------+       |
|                         v                                    ^                 |
|                  +--------------------+        +-------------+                 |
|                  | ClickUpSyncService | <----> |  SyncQueue  |                 |
|                  +--------------------+        +-------------+                 |
+---------------------------|----------------------------------------------------+
                            | HTTPS / API v2
                            v
                  +--------------------+
                  |    ClickUp API     |
                  +--------------------+
```

### 2.1 Princípios

* **Core puro e testável:** cálculo de tempo, segmentos, arredondamento, política de idle e parsing de IDs ficam em `src/core/`, sem dependência de `vscode`, e são testados com Vitest.
* **Timestamps, não ticks:** o tempo é sempre calculado por `Date.now()` sobre segmentos `{start, end}`. Nunca é uma soma de ticks do timer de 1 Hz, para continuar correto quando o computador suspende ou o event loop atrasa.
* **Estado único em disco:** a fonte da verdade é o arquivo JSON em `~/.clickup-devtimer/` (ver seção 5), compartilhado por todas as janelas e por todos os editores compatíveis (VS Code, Insiders, Cursor etc.).

### 2.2 Módulos Internos

#### A. `StatusBarUI` / `QuickPickUI` (Camada de Apresentação)

* Gerencia o item dinâmico na barra de status (`vscode.StatusBarItem`).
* Renderiza menus e seletores via `vscode.window.showQuickPick` / `createQuickPick`.
* Atualiza o cronômetro visual em tempo real (1 Hz, só renderização).
* Usa `ThemeColor` para fundos (`statusBarItem.warningBackground`, `statusBarItem.errorBackground`), compatível com temas claros e escuros.
* Tooltip em `MarkdownString` com: nome completo da task, ID, lista/projeto, tempo da sessão, **total do dia** e pendências de sync.

#### B. `ActivityWatcher` (Detector de Atividade/Inatividade)

Mantém `lastActivityTime` e o publica para o `WindowCoordinator`, já que a atividade de qualquer janela conta (ver 2.2-E).

**Sinais que contam como atividade** (só movimentos reais do usuário):

| Fonte | Evento | Filtro anti falso-positivo |
| --- | --- | --- |
| Edição | `workspace.onDidChangeTextDocument` | Só se a janela estiver focada **e** o documento for o do editor ativo. Ignora os schemes `output`, `debug`, `git` e `vscode-*`. Ignora mudanças vazias. Evita contar edições de formatters, agentes de IA e logs. |
| Cursor/seleção | `window.onDidChangeTextEditorSelection` | Janela focada. |
| Navegação | `window.onDidChangeActiveTextEditor` | Janela focada. |
| Scroll | `window.onDidChangeTextEditorVisibleRanges` | Janela focada. |
| Salvar | `workspace.onDidSaveTextDocument` | Janela focada. |
| Notebooks | `window.onDidChangeNotebookEditorSelection` | Janela focada. |
| Terminal | `window.onDidOpenTerminal`, `window.onDidChangeActiveTerminal`, `window.onDidStartTerminalShellExecution`, `window.onDidChangeTerminalState` | Janela focada. A shell execution só conta se o terminal for o ativo. |
| Debug | `debug.onDidStartDebugSession`, `debug.onDidChangeActiveStackItem` (step/breakpoint hit), `debug.onDidChangeBreakpoints` | Janela focada. |

**Sinais que NÃO contam (decisão explícita):**
* `window.onDidChangeWindowState` (foco/desfoco da janela), porque dá falso positivo.
* `onDidOpenTextDocument` / `onDidCloseTextDocument`, porque são disparados por extensões e pelo Git sem ação do usuário.
* Tasks em background, file watchers e mudanças vindas de processos externos.

**Detecção:** um timer a cada 10s calcula `now - lastActivityGlobal`, onde `lastActivityGlobal` é o máximo entre todas as janelas. Se o valor passar de `inactivityThresholdSeconds` (padrão 120s), o `StateManager` é notificado.

Para não gravar no disco a cada tecla, o watcher grava no máximo uma vez a cada 5s.

#### C. `StateManager` (Gerenciador de Estado)

* Máquina de estados da sessão (ver seção 3.1).
* Mantém a sessão como uma lista de **segmentos contínuos** `{start, end}`.
* Persiste via `StorageService` a cada transição de estado e a cada `autoSaveIntervalSeconds` (padrão 60s).
* Faz a recuperação de sessões interrompidas (crash, fechamento de todas as janelas).
* Emite eventos (`onDidChangeState`) consumidos pela UI.

#### D. `ClickUpSyncService` (Cliente HTTP)

* Autenticação com Personal Token guardado em `context.secrets` (SecretStorage API).
* Cliente HTTP com `fetch` nativo (Node 20 do VS Code ≥ 1.93). Sem axios.
* Rate limit: token bucket no cliente (100 req/min por padrão). Em `429`, respeita o header `X-RateLimit-Reset`.
* `401` invalida o token e muda a UI para "Token inválido".
* Timeout de 15s por requisição, com `AbortController`.

#### E. `WindowCoordinator` (Coordenação Multi-janela)

* Cada janela gera um `windowId` (UUID) na ativação.
* **Dono do timer:** a janela que detém o lock (`lock.json`), com `{windowId, pid, heartbeatAt}`. Só o dono roda o **trabalho de fundo**: detecção de idle, retomada automática, avisos, autosave e envio da fila.
* **Heartbeat:** o dono renova `heartbeatAt` a cada 5s. Se o heartbeat ficar mais de 30s sem renovação, ou se o processo dono não existir mais (`pid` morto), qualquer janela assume o lock, e a sessão continua sem interrupção. Quando duas janelas disputam o lock, vale a última escrita: cada janela relê o lock após gravá-lo para confirmar.
* **Atividade compartilhada:** todas as janelas gravam o seu `lastActivityTime` em `activity.json` (mapa `windowId → timestamp`, throttle de 5s). O dono usa o máximo desses valores.
* **Ações do usuário em qualquer janela:** comandos como pausar, retomar, finalizar e trocar de task são aplicados direto no `state.json` (ler, transformar, gravar) pela janela onde o usuário agiu. Não há troca de mensagens entre janelas. As demais janelas atualizam a exibição por polling do estado (a cada 2s).
* Escrita atômica: grava em arquivo temporário e depois faz `rename`.

#### F. `SyncQueue` (Fila Offline)

* Toda entrada de tempo a enviar passa pela fila (`queue.json`), não só as que falharam.
* Cada item tem `{id (uuid), taskId, teamId, start, duration, description, attempts, lastError, status}`.
* **Sync automático:** a fila é processada:
  * na ativação da extensão;
  * a cada `syncRetryIntervalMinutes` (padrão 5);
  * logo após qualquer requisição bem-sucedida à API, porque indica que a rede voltou.
* Backoff exponencial por item (1, 2, 4, 8... até 60 min).
* **Proteção contra duplicidade:** se uma tentativa terminar em timeout ou erro de rede sem resposta (resultado incerto), antes de reenviar o item a fila consulta `GET /team/{team_id}/time_entries` no intervalo `[start, start+duration]` da task. Se já existir uma entrada com o mesmo `start` e `duration`, o item é marcado como enviado.
* Erros `4xx` não recuperáveis (exceto 401/429) marcam o item como `failed` e exigem ação manual pelo comando "Ver pendências".

#### G. `GitIntegration`

* Usa a API da extensão nativa `vscode.git` (`getAPI(1)`).
* Escuta `repository.state.onDidChange` para detectar troca de branch (`HEAD.name`).
* Extrai IDs de task do nome da branch com as regex configuráveis (`branchDetection.patterns`).
* Fornece o nome da branch atual para a sugestão de descrição do time entry.

---

## 3. Especificação do Fluxo de Uso (UX / UI)

### 3.1 Máquina de Estados

```
 NotConfigured --(token válido)--> Idle(sem task)
 Idle --(selecionar task)--> Running
 Running --(pausa manual)--> PausedManual
 Running --(inatividade)--> PausedIdle
 PausedIdle --(atividade detectada)--> Running            (retomada automática)
 PausedManual --(retomar)--> Running
 Running|Paused* --(finalizar)--> Finalizing --> Idle      (entradas vão para a SyncQueue)
 Running|Paused* --(trocar task)--> Finalizing --> Running(nova task)
 Running|Paused* --(descartar)--> Idle
```

### 3.2 Estados da Barra de Status

| Estado | Ícone & Texto | Estilo | Ação ao Clicar |
| --- | --- | --- | --- |
| **Não Configurado** | `$(key) ClickUp: Configurar Token` | `warningBackground` | Abre o prompt para colar o Personal Token |
| **Token Inválido** | `$(error) ClickUp: Token inválido` | `errorBackground` | Abre o prompt para colar o Personal Token |
| **Sem Task Ativa** | `$(list-selection) ClickUp: Selecionar Task` | Padrão | Abre o seletor de tasks |
| **Contando Tempo** | `$(play-circle) 01:23:45 · Fix Login Bug` | Foreground verde (`charts.green`) | Abre o Menu de Controle |
| **Pausado (Manual)** | `$(debug-pause) 01:23:45 (Pausado)` | `warningBackground` | Abre o Menu de Controle |
| **Pausado (Idle)** | `$(history) 01:23:45 (Inativo)` | Foreground laranja (`charts.orange`) | Abre o Menu de Controle (com Retomar) |
| **Pendências de Sync** | Sufixo `$(warning) 2` no texto atual | `errorBackground` se houver itens `failed` | Abre "Ver pendências" |

Todas as janelas e editores mostram o mesmo timer, e as ações funcionam em qualquer um deles. Por isso não existe um estado visual de "outra janela".

O nome da task é truncado em `statusBar.maxTaskNameLength` caracteres (padrão 30). O nome completo fica no tooltip.

### 3.3 Menu de Controle (QuickPick)

As opções variam conforme o estado:

1. `$(debug-pause) Pausar Cronômetro`, ou `$(play) Retomar Cronômetro`
2. `$(cloud-upload) Finalizar e Sincronizar com ClickUp`
3. `$(arrow-swap) Trocar de Tarefa`
4. `$(link-external) Abrir Tarefa no Navegador`
5. `$(trash) Descartar Tempo Atual` (pede confirmação modal)
6. `$(cloud) Ver Pendências de Sync` (só se houver)

### 3.4 Seletor de Tasks

QuickPick com busca (`matchOnDescription`, `matchOnDetail`), organizado em seções (`QuickPickItemKind.Separator`):

1. **Recentes:** as últimas `recentTasksCount` tasks usadas (padrão 5).
2. **Em andamento:** tasks atribuídas ao usuário com status em `activeStatuses`.
3. **Outras atribuídas:** as demais tasks atribuídas e não fechadas.

Cada item mostra no label o nome, na description o ID (custom ID, se houver) e o status, e no detail a lista e a pasta (cliente/projeto).

**Entrada livre:** se o texto digitado for um ID (`86bx123ab`), um custom ID (`DEV-123`) ou uma URL do ClickUp (`https://app.clickup.com/t/86bx123ab` ou `https://app.clickup.com/t/{team_id}/DEV-123`), aparece o item dinâmico `$(search) Buscar task "<valor>"`. Ele resolve a task via `GET /task/{id}` e funciona para qualquer task, mesmo não atribuída.

**Cache:** a lista fica em cache por `taskCacheTtlMinutes` (padrão 5). Um botão `$(refresh)` no título do QuickPick força o refresh.

### 3.5 Inatividade e Pausas

| Situação | Comportamento |
| --- | --- |
| Sem atividade por mais de `inactivityThresholdSeconds` | Vai para **PausedIdle**. O segmento atual é fechado com `end = lastActivityGlobal`, ou seja, **o tempo ocioso é descontado**. |
| Atividade detectada em PausedIdle | **Retomada automática.** Abre um novo segmento com `start = now` e mostra uma mensagem discreta na status bar (`setStatusBarMessage`, 5s): "Timer retomado após 25 min de inatividade". |
| Atividade detectada em **PausedManual** | Depois de atividade contínua por mais de 60s, notifica: *"Detectamos atividade no editor. Você ainda está em pausa?"* `[Retomar]` `[Continuar pausado]`. Se escolher "Continuar pausado", não pergunta de novo por 15 min. |
| Pausa manual longa (mais de `longPauseWarningMinutes`, padrão 60) | Notifica: *"O timer está pausado há 1h. O que deseja fazer?"* `[Retomar]` `[Finalizar e sincronizar]` `[Descartar]`. Repete a cada intervalo. |
| Virada do dia com sessão pausada | Na primeira ativação ou atividade do novo dia, oferece `[Finalizar e sincronizar]` `[Continuar]`. |
| Sessão longa contínua (mais de `longSessionWarningMinutes`, padrão 240) | Notificação informativa: *"Você está há 4h na task X."* `[Ok]` `[Finalizar]`. |

### 3.6 Finalização e Descrição do Time Entry

Ao **Finalizar e Sincronizar**:

1. Abre um `InputBox`/QuickPick editável para a **descrição**, pré-preenchida com o nome da branch atual (quando houver). Sugestões disponíveis:
   * Nome da branch atual (ex.: `feature/CU-86bx123-fix-login`)
   * `Logged via ClickUp DevTimer (VS Code)`
   * Campo livre (o usuário digita)

   `Esc` envia com a descrição pré-preenchida (não cancela o sync). Isso pode ser desligado com `askDescriptionOnFinish = false`, caso em que a branch ou o texto padrão é usado direto.
2. Aplica a duração mínima e o arredondamento (seção 3.7).
3. Gera **uma entrada por segmento contínuo** e as coloca na `SyncQueue`.
4. A fila processa as entradas imediatamente.

Na **troca de task** e na finalização disparada pelas notificações da seção 3.5, o mesmo fluxo é executado automaticamente.

### 3.7 Duração Mínima e Arredondamento

* `minimumEntrySeconds` (padrão 60): se o **total da sessão** for menor que esse valor, a sessão é descartada com aviso. Segmentos individuais menores que 60s são fundidos ao segmento seguinte quando o intervalo entre eles for menor que o threshold de idle. Caso contrário, são descartados.
* `roundingMinutes` (padrão **5**, `0` desliga): o **total da sessão** é arredondado para o múltiplo mais próximo (`roundingMode`: `nearest` padrão, `up` ou `down`). A diferença é aplicada no último segmento. Se o ajuste exceder a duração dele, o restante vai para os segmentos anteriores.
* A lógica fica em `src/core/rounding.ts` (função pura com testes).

### 3.8 Sugestão de Mudança de Status

Quando `suggestStatusChange = true` (padrão):

* **Ao iniciar o timer**, se o status da task não estiver em `activeStatuses`, notifica: *"A task está em 'to do'. Mover para 'in progress'?"* `[Mover]` `[Escolher status...]` `[Não]` `[Não perguntar novamente]`.
  * "Mover" usa o primeiro status de `activeStatuses` que exista na lista da task.
  * "Escolher status..." abre um QuickPick com os status da lista (`GET /list/{list_id}`).
* **Ao finalizar**, se a task estiver num status ativo, oferece um QuickPick opcional *"Atualizar status da task?"* com os status da lista e a opção `Manter`.

### 3.9 Integração com Git (Branch → Task)

* Na ativação e a cada troca de branch, extrai os IDs com `branchDetection.patterns` (padrão: `["CU-([a-z0-9]+)", "([A-Z][A-Z0-9]+-\\d+)"]`, grupo 1 = ID).
* Valida o ID via API. Se a task não for encontrada, não faz nada (silencioso).
* Se não houver timer ativo: *"A branch `feature/CU-86bx123-fix-login` referencia 'Fix Login Bug'. Iniciar timer?"* `[Iniciar]` `[Ignorar]` `[Não perguntar para esta branch]`.
* Se houver timer ativo em **outra** task: *"... Trocar o timer para esta task?"* `[Trocar]` `[Manter]`.
* Se o timer já estiver nessa task: nada.
* Desligável com `branchDetection.enabled`.

### 3.10 Relatórios por Cliente/Projeto (nota)

O modelo de uma entrada por segmento **não prejudica** a análise de consumo por cliente/projeto:

* O campo **Time Tracked** da task no ClickUp é a soma de todas as entradas da task, independentemente de quantas forem.
* As visões nativas (**Timesheets**, **Time Reporting** e o widget de **Time Tracking** nos Dashboards) agregam por Space/Folder/List/usuário/período. Se cada cliente/projeto for um Space, Folder ou List, o consumo da sprint sai direto dessas visões.
* Como bônus, as entradas têm horários reais (`start`), o que permite filtrar por período exato da sprint.

---

## 4. Integração com a API do ClickUp

Base: `https://api.clickup.com/api/v2`. Todas as requisições usam o header `Authorization: {PERSONAL_TOKEN}`.

### 4.1 Endpoints Utilizados

| # | Método & Rota | Finalidade |
| --- | --- | --- |
| 1 | `GET /user` | Validar o token e obter `user.id`. |
| 2 | `GET /team` | Listar Workspaces. Se houver mais de 1, o usuário escolhe no setup e a escolha vai para `clickupDevTimer.teamId`. |
| 3 | `GET /team/{team_id}/task` | Listar tasks atribuídas. Query: `assignees[]={user_id}`, `include_closed=false`, `subtasks=true`, `order_by=updated`, `page={n}`. **Paginado:** 100 por página. Itera até `last_page = true` (limite de segurança de 10 páginas). |
| 4 | `GET /task/{task_id}` | Resolver uma task por ID, custom ID ou URL. Para custom ID: `?custom_task_ids=true&team_id={team_id}`. |
| 5 | `GET /list/{list_id}` | Obter os status disponíveis da lista (para a sugestão de mudança de status). |
| 6 | `PUT /task/{task_id}` | Atualizar o status. Body: `{ "status": "in progress" }`. |
| 7 | `POST /team/{team_id}/time_entries` | **Registrar tempo** (endpoint atual, substitui o legado `POST /task/{id}/time`). |
| 8 | `GET /team/{team_id}/time_entries` | Verificar duplicidade antes de um retry com resultado incerto. Query: `start_date`, `end_date`, `task_id`. |

### 4.2 Payload de Registro de Tempo

`POST /team/{team_id}/time_entries`

```json
{
  "tid": "86bx123ab",
  "start": 1760184000000,
  "duration": 3600000,
  "description": "feature/CU-86bx123ab-fix-login"
}
```

* `start` e `duration` em **milissegundos** (epoch / duração).
* `tid` é sempre o ID interno da task. Custom IDs são resolvidos antes de entrar na fila.
* `billable` e `tags` não são enviados na v1.
* Uma requisição por segmento contínuo.

### 4.3 Tratamento de Respostas

| Código | Ação |
| --- | --- |
| 2xx | Sucesso. Remove o item da fila e dispara o processamento do restante. |
| 401 | Token inválido. Muda a UI para "Token inválido" e pausa a fila. |
| 429 | Aguarda `X-RateLimit-Reset` e reprocessa. |
| 5xx / rede / timeout | Retry com backoff. Timeout gera a verificação de duplicidade (2.2-F). |
| Outros 4xx | Item `failed`. O usuário é notificado e resolve pelo comando "Ver pendências" (`[Tentar novamente]`, `[Abrir task]`, `[Descartar]`). |

---

## 5. Persistência

Os arquivos ficam na pasta **`~/.clickup-devtimer/`**, dentro do home do usuário no sistema operacional (`os.homedir()`). Exemplos: `C:\Users\<user>\.clickup-devtimer` no Windows e `/home/<user>/.clickup-devtimer` no Linux. Não é preciso configurar nada.

* **Por que não `context.globalStorageUri`:** essa pasta é separada por editor. Com uma pasta no home, VS Code, VS Code Insiders, Cursor e outros forks compartilham **um único timer**, sem contagem dupla quando dois editores ficam abertos ao mesmo tempo.
* **Remote (SSH, WSL, Dev Containers):** a extensão declara `"extensionKind": ["ui"]` e sempre roda na máquina local. Assim o estado fica no home local, mesmo trabalhando em um workspace remoto.
* **Desinstalação:** a pasta não é removida automaticamente. O README documenta como apagá-la.
* **Testes:** o `StorageService` recebe o diretório por parâmetro. Os testes usam um diretório temporário.

Arquivos:

| Arquivo | Conteúdo |
| --- | --- |
| `state.json` | Sessão ativa (schema abaixo), tasks recentes, branches ignoradas e flags de "não perguntar". |
| `lock.json` | `{ windowId, pid, heartbeatAt }` |
| `activity.json` | `{ [windowId]: lastActivityTime }` |
| `queue.json` | Itens da SyncQueue. |

Todos os arquivos têm `schemaVersion` para migrações futuras.

```ts
interface Session {
  schemaVersion: 1;
  id: string;                                         // único por sessão (ver §6.1)
  task: { id: string; customId?: string; name: string; url: string; listId: string; teamId: string };
  status: 'running' | 'pausedManual' | 'pausedIdle';
  segments: Array<{ start: number; end: number }>;   // trechos fechados
  openSegmentStart: number | null;                    // trecho em andamento
  pausedAt: number | null;
  lastActivityTime: number;
  lastPersistedAt: number;
}
```

O token **nunca** é gravado nesses arquivos. Ele fica só em `context.secrets`.

---

## 6. Tratamento de Exceções & Casos de Borda

1. **Crash da IDE ou fechamento de todas as janelas:**
   * Na ativação, se `state.json` tiver uma sessão e o lock estiver expirado, o segmento aberto é fechado em `end = lastActivityTime`, sem contar o tempo em que a IDE ficou fechada.
   * A extensão pergunta: *"Identificamos 01h 15m não sincronizados na tarefa [CU-123] Fix Login Bug. O que deseja fazer?"* `[Enviar]` `[Continuar contando]` `[Descartar]`.
   * Até o usuário escolher, a sessão recuperada fica **pausada manualmente**, então atividade no editor não a retoma sozinha.
   * "Continuar contando" mantém os segmentos anteriores e abre um novo a partir de agora.
   * Cada sessão tem um `id`, e os itens da fila guardam o `sessionId`. Se o editor travar logo depois de enfileirar os lançamentos e antes de limpar a sessão, a recuperação encontra o `sessionId` na fila, limpa a sessão e **não envia o tempo duas vezes**.
2. **Fechamento de uma janela com outras abertas:** outra janela assume o lock em até 30s e a sessão continua.
3. **Perda de conexão:** o tempo nunca é perdido, porque fica na fila (2.2-F). A status bar mostra as pendências.
4. **Token revogado durante a sessão:** a contagem continua localmente. A fila pausa até o novo token ser configurado.
5. **Task excluída ou sem acesso (404/403 no sync):** item `failed`, resolvido em "Ver pendências".
6. **Suspensão do computador:** a ausência de eventos durante a suspensão já é tratada pelo idle. Na volta, o segmento fecha em `lastActivityTime`.
7. **Mudança do relógio do sistema:** se `now < lastPersistedAt`, o segmento aberto é fechado em `lastPersistedAt` e um novo é aberto.
8. **Workspace trocado nas settings com sessão ativa:** a sessão atual mantém o seu `teamId`. A mudança vale para a próxima sessão.

---

## 7. Configurações (`contributes.configuration`)

| Chave | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `clickupDevTimer.teamId` | string | `""` | Workspace do ClickUp. Preenchido no setup. |
| `clickupDevTimer.activeStatuses` | string[] | `["in progress", "doing", "in dev"]` | Status considerados "em andamento" (comparação case-insensitive). |
| `clickupDevTimer.inactivityThresholdSeconds` | number | `120` | Segundos sem atividade até a pausa automática (mín. 30). |
| `clickupDevTimer.autoSaveIntervalSeconds` | number | `60` | Intervalo de gravação periódica do estado. |
| `clickupDevTimer.minimumEntrySeconds` | number | `60` | Duração mínima de uma sessão para sincronizar. |
| `clickupDevTimer.roundingMinutes` | number | `5` | Arredondamento do total da sessão (0 = desligado). |
| `clickupDevTimer.roundingMode` | enum | `nearest` | `nearest` / `up` / `down`. |
| `clickupDevTimer.askDescriptionOnFinish` | boolean | `true` | Pedir a descrição ao finalizar. |
| `clickupDevTimer.defaultDescription` | string | `Logged via ClickUp DevTimer (VS Code)` | Texto padrão sugerido. |
| `clickupDevTimer.longPauseWarningMinutes` | number | `60` | Aviso de pausa manual longa (0 = desligado). |
| `clickupDevTimer.longSessionWarningMinutes` | number | `240` | Aviso de sessão longa (0 = desligado). |
| `clickupDevTimer.suggestStatusChange` | boolean | `true` | Sugerir mudança de status ao iniciar e finalizar. |
| `clickupDevTimer.branchDetection.enabled` | boolean | `true` | Detectar a task pelo nome da branch. |
| `clickupDevTimer.branchDetection.patterns` | string[] | `["CU-([a-z0-9]+)", "([A-Z][A-Z0-9]+-\\d+)"]` | Regex com o ID no grupo 1. |
| `clickupDevTimer.recentTasksCount` | number | `5` | Quantidade de tasks recentes no seletor. |
| `clickupDevTimer.taskCacheTtlMinutes` | number | `5` | TTL do cache da lista de tasks. |
| `clickupDevTimer.syncRetryIntervalMinutes` | number | `5` | Intervalo do processamento automático da fila. |
| `clickupDevTimer.statusBar.maxTaskNameLength` | number | `30` | Truncamento do nome na status bar. |

---

## 8. Comandos

| ID | Título (en) |
| --- | --- |
| `clickupDevTimer.setToken` | ClickUp DevTimer: Set Personal Token |
| `clickupDevTimer.clearToken` | ClickUp DevTimer: Sign Out (Clear Token) |
| `clickupDevTimer.selectWorkspace` | ClickUp DevTimer: Select Workspace |
| `clickupDevTimer.selectTask` | ClickUp DevTimer: Select / Start Task |
| `clickupDevTimer.showMenu` | ClickUp DevTimer: Show Timer Menu |
| `clickupDevTimer.pauseTimer` | ClickUp DevTimer: Pause Timer |
| `clickupDevTimer.resumeTimer` | ClickUp DevTimer: Resume Timer |
| `clickupDevTimer.syncTime` | ClickUp DevTimer: Stop & Sync Time to ClickUp |
| `clickupDevTimer.switchTask` | ClickUp DevTimer: Switch Task |
| `clickupDevTimer.discardTime` | ClickUp DevTimer: Discard Current Time |
| `clickupDevTimer.openInBrowser` | ClickUp DevTimer: Open Task in Browser |
| `clickupDevTimer.showPendingSync` | ClickUp DevTimer: Show Pending Sync |
| `clickupDevTimer.refreshTasks` | ClickUp DevTimer: Refresh Task List |

Comandos que dependem de estado usam `enablement` / `when` com context keys (`clickupDevTimer.state`, `clickupDevTimer.hasPending`).

---

## 9. Internacionalização

* Idiomas: **en** (padrão) e **pt-BR**.
* Manifesto: `package.nls.json` e `package.nls.pt-br.json`.
* Runtime: `vscode.l10n.t(...)` com `l10n/bundle.l10n.pt-br.json`.
* Nenhuma string de UI hardcoded fora do l10n. Uma regra de lint/teste verifica que as chaves existem nos dois idiomas.

---

## 10. Engenharia

### 10.1 Stack

| Área | Escolha |
| --- | --- |
| Linguagem | TypeScript (`strict: true`, `noUncheckedIndexedAccess`) |
| Engine mínima | VS Code `^1.93.0` (APIs estáveis de shell execution do terminal, Node 20 com `fetch`) |
| Bundle | **esbuild** (bundle único `dist/extension.js`, minificado em produção, sourcemaps em dev) |
| HTTP | `fetch` nativo |
| Testes unitários | **Vitest** (v5; `@types/node` 22) para `src/core/*` e serviços com `vscode` mockado. Meta de cobertura do core ≥ 90%. |
| Testes de integração | **`@vscode/test-cli` + `@vscode/test-electron`** (Mocha), com mock HTTP da API do ClickUp |
| Qualidade | **ESLint** (flat config + `typescript-eslint`), **Prettier**, `tsc --noEmit` |
| Empacotamento | `@vscode/vsce` (Marketplace) e `ovsx` (Open VSX) |
| Commits | Conventional Commits. Changelog gerado a partir deles. |

### 10.2 CI/CD (GitHub Actions)

* **`ci.yml`** (push/PR): lint, typecheck, unit tests e integration tests (via `xvfb` no Linux) em matrix **ubuntu / windows / macos**, mais `vsce package` como artifact.
* **`release.yml`** (tag `v*`): build, testes, `vsce publish` (secret `VSCE_PAT`), `ovsx publish` (secret `OVSX_PAT`) e GitHub Release com o `.vsix`.

### 10.3 Repositório Público

O repositório é público em `github.com/andradevander/clickup-devtimer`.

* **Segredos:** `VSCE_PAT` e `OVSX_PAT` ficam só nos GitHub Secrets. O **Secret scanning** e a **Push protection** ficam ativos.
* **Dados de teste:** fixtures e mocks da API usam apenas dados fictícios. Nunca IDs, nomes de clientes ou tasks reais.
* **Branch `main` protegida:** merge só via PR com o CI verde. Dependabot ativo para npm e GitHub Actions.
* **Vulnerabilidades:** reportadas pelo *Private vulnerability reporting* do GitHub (ver `SECURITY.md`), nunca em issues públicas.
* **Arquivos de comunidade:** `LICENSE` (MIT), `SECURITY.md`, `.gitignore`. O `CONTRIBUTING.md` é opcional.

### 10.4 Estrutura do Projeto

```text
clickup-devtimer/
├── .github/workflows/
│   ├── ci.yml
│   └── release.yml
├── .github/dependabot.yml
├── .vscode/
│   ├── launch.json
│   └── tasks.json
├── l10n/
│   └── bundle.l10n.pt-br.json
├── src/
│   ├── extension.ts                # activate/deactivate, composição dos módulos
│   ├── constants.ts                # URLs, chaves de storage, defaults
│   ├── config.ts                   # leitura tipada das settings
│   ├── types/
│   │   ├── clickup.ts              # Tipos da API (User, Team, Task, TimeEntry)
│   │   └── session.ts              # Session, Segment, QueueItem
│   ├── core/                       # Lógica pura, sem `vscode`
│   │   ├── timeMath.ts             # Soma de segmentos, fechamento, formatação
│   │   ├── rounding.ts             # Duração mínima e arredondamento
│   │   ├── idlePolicy.ts           # Regras de idle, pausa longa, virada de dia
│   │   ├── taskIdParser.ts         # ID / custom ID / URL / branch → taskId
│   │   └── stateMachine.ts         # Transições de estado
│   ├── services/
│   │   ├── clickupService.ts       # Cliente HTTP + rate limit
│   │   ├── stateManager.ts
│   │   ├── activityWatcher.ts
│   │   ├── windowCoordinator.ts
│   │   ├── storageService.ts       # JSON atômico em ~/.clickup-devtimer
│   │   ├── syncQueue.ts
│   │   └── gitIntegration.ts
│   └── ui/
│       ├── statusBar.ts
│       ├── taskPicker.ts
│       ├── controlMenu.ts
│       └── notifications.ts
├── test/
│   ├── unit/                       # Vitest
│   └── integration/                # @vscode/test-electron (tsconfig.json próprio, Mocha)
├── esbuild.mjs
├── eslint.config.mjs
├── vitest.config.mts
├── .vscode-test.mjs
├── package.json
├── package.nls.json
├── package.nls.pt-br.json
├── tsconfig.json
├── .gitignore
├── CHANGELOG.md
├── LICENSE
├── SECURITY.md
└── README.md
```

---

## 11. Fora de Escopo (v1)

* OAuth App (apenas Personal Token na v1).
* Campos `billable` e `tags` nos time entries.
* Descrição gerada automaticamente a partir de commits.
* Timer nativo do ClickUp em tempo real (`/time_entries/start`), porque o controle de idle é local.
* Relatórios dentro da extensão.

---

## 12. Guia do Usuário: Como obter o Personal Token do ClickUp

*(Este texto deve ser incorporado ao `README.md` do projeto e disponibilizado como ajuda dentro da extensão.)*

### 🔑 Passo a Passo para Obter seu Personal Token

Para integrar o **ClickUp DevTimer** ao seu ambiente, você precisa de um token pessoal gerado no ClickUp.

1. Faça login na sua conta do ClickUp no navegador.
2. Clique no ícone do seu **Perfil/Avatar** (no canto inferior esquerdo ou superior direito, dependendo do layout).
3. Selecione **Settings** (Configurações).
4. No menu lateral, vá até a seção **Apps**.
5. Na seção **API Token**, clique em **Generate** (ou copie o código existente, se já tiver um).
6. O token gerado terá um formato parecido com `pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXX`.
7. No VS Code, abra a Paleta de Comandos (`Ctrl+Shift+P`, ou `Cmd+Shift+P` no Mac), digite `ClickUp DevTimer: Set Personal Token` e cole a chave.
8. Se você participar de mais de um Workspace, escolha qual usar. É possível trocar depois com `ClickUp DevTimer: Select Workspace`.

---

## 13. Manifesto Inicial (`package.json`)

```json
{
  "name": "clickup-devtimer",
  "displayName": "%displayName%",
  "description": "%description%",
  "version": "0.1.0",
  "publisher": "andradevander",
  "repository": { "type": "git", "url": "https://github.com/andradevander/clickup-devtimer.git" },
  "bugs": { "url": "https://github.com/andradevander/clickup-devtimer/issues" },
  "license": "MIT",
  "l10n": "./l10n",
  "engines": {
    "vscode": "^1.93.0"
  },
  "categories": ["Productivity", "Other"],
  "keywords": ["clickup", "time tracking", "timer", "productivity", "timesheet"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "extensionDependencies": [],
  "contributes": {
    "commands": [
      { "command": "clickupDevTimer.setToken", "title": "%command.setToken%" },
      { "command": "clickupDevTimer.clearToken", "title": "%command.clearToken%" },
      { "command": "clickupDevTimer.selectWorkspace", "title": "%command.selectWorkspace%" },
      { "command": "clickupDevTimer.selectTask", "title": "%command.selectTask%" },
      { "command": "clickupDevTimer.showMenu", "title": "%command.showMenu%" },
      { "command": "clickupDevTimer.pauseTimer", "title": "%command.pauseTimer%", "enablement": "clickupDevTimer.state == running" },
      { "command": "clickupDevTimer.resumeTimer", "title": "%command.resumeTimer%", "enablement": "clickupDevTimer.state =~ /^paused/" },
      { "command": "clickupDevTimer.syncTime", "title": "%command.syncTime%", "enablement": "clickupDevTimer.hasSession" },
      { "command": "clickupDevTimer.switchTask", "title": "%command.switchTask%", "enablement": "clickupDevTimer.hasSession" },
      { "command": "clickupDevTimer.discardTime", "title": "%command.discardTime%", "enablement": "clickupDevTimer.hasSession" },
      { "command": "clickupDevTimer.openInBrowser", "title": "%command.openInBrowser%", "enablement": "clickupDevTimer.hasSession" },
      { "command": "clickupDevTimer.showPendingSync", "title": "%command.showPendingSync%" },
      { "command": "clickupDevTimer.refreshTasks", "title": "%command.refreshTasks%" }
    ],
    "configuration": {
      "title": "ClickUp DevTimer",
      "properties": {
        "clickupDevTimer.teamId": { "type": "string", "default": "", "description": "%config.teamId%" },
        "clickupDevTimer.activeStatuses": { "type": "array", "items": { "type": "string" }, "default": ["in progress", "doing", "in dev"], "description": "%config.activeStatuses%" },
        "clickupDevTimer.inactivityThresholdSeconds": { "type": "number", "default": 120, "minimum": 30, "description": "%config.inactivityThresholdSeconds%" },
        "clickupDevTimer.autoSaveIntervalSeconds": { "type": "number", "default": 60, "minimum": 10, "description": "%config.autoSaveIntervalSeconds%" },
        "clickupDevTimer.minimumEntrySeconds": { "type": "number", "default": 60, "minimum": 0, "description": "%config.minimumEntrySeconds%" },
        "clickupDevTimer.roundingMinutes": { "type": "number", "default": 5, "minimum": 0, "description": "%config.roundingMinutes%" },
        "clickupDevTimer.roundingMode": { "type": "string", "enum": ["nearest", "up", "down"], "default": "nearest", "description": "%config.roundingMode%" },
        "clickupDevTimer.askDescriptionOnFinish": { "type": "boolean", "default": true, "description": "%config.askDescriptionOnFinish%" },
        "clickupDevTimer.defaultDescription": { "type": "string", "default": "Logged via ClickUp DevTimer (VS Code)", "description": "%config.defaultDescription%" },
        "clickupDevTimer.longPauseWarningMinutes": { "type": "number", "default": 60, "minimum": 0, "description": "%config.longPauseWarningMinutes%" },
        "clickupDevTimer.longSessionWarningMinutes": { "type": "number", "default": 240, "minimum": 0, "description": "%config.longSessionWarningMinutes%" },
        "clickupDevTimer.suggestStatusChange": { "type": "boolean", "default": true, "description": "%config.suggestStatusChange%" },
        "clickupDevTimer.branchDetection.enabled": { "type": "boolean", "default": true, "description": "%config.branchDetection.enabled%" },
        "clickupDevTimer.branchDetection.patterns": { "type": "array", "items": { "type": "string" }, "default": ["CU-([a-z0-9]+)", "([A-Z][A-Z0-9]+-\\d+)"], "description": "%config.branchDetection.patterns%" },
        "clickupDevTimer.recentTasksCount": { "type": "number", "default": 5, "minimum": 0, "description": "%config.recentTasksCount%" },
        "clickupDevTimer.taskCacheTtlMinutes": { "type": "number", "default": 5, "minimum": 0, "description": "%config.taskCacheTtlMinutes%" },
        "clickupDevTimer.syncRetryIntervalMinutes": { "type": "number", "default": 5, "minimum": 1, "description": "%config.syncRetryIntervalMinutes%" },
        "clickupDevTimer.statusBar.maxTaskNameLength": { "type": "number", "default": 30, "minimum": 0, "description": "%config.statusBar.maxTaskNameLength%" }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run build:prod",
    "build": "node esbuild.mjs",
    "build:prod": "node esbuild.mjs --production",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test:unit": "vitest run",
    "test:integration": "vscode-test",
    "test": "npm run test:unit && npm run test:integration",
    "package": "vsce package",
    "publish:vsce": "vsce publish",
    "publish:ovsx": "ovsx publish"
  },
  "devDependencies": {
    "@types/node": "^20.x",
    "@types/vscode": "^1.93.0",
    "@types/mocha": "^10.x",
    "@vscode/test-cli": "^0.0.x",
    "@vscode/test-electron": "^2.x",
    "@vscode/vsce": "^3.x",
    "esbuild": "^0.24.x",
    "eslint": "^9.x",
    "typescript-eslint": "^8.x",
    "ovsx": "^0.10.x",
    "prettier": "^3.x",
    "typescript": "^5.x",
    "vitest": "^2.x"
  }
}
```

*(As versões exatas das devDependencies são fixadas no lockfile durante o setup do projeto.)*
