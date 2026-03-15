# Hollow

Transferência de arquivos P2P direto no terminal. Sem servidor intermediário — os arquivos vão do seu computador direto pro do outro.

Usa QUIC (UDP) para conexão segura com TLS, com traversal de NAT via STUN e retomada automática de transferências interrompidas.

---

## Como usar

```
Hollow [--bind <endereço>] [--peer <endereço>]
```

### Fluxo básico

1. **Abra o Hollow** nos dois computadores
2. **Compartilhe seu endereço** — aparece em "Para compartilhar" na UI (IP público detectado via STUN, ou IP local em redes sem internet)
3. **Cole o endereço do outro** no campo de peer e conecte
4. **Arraste ou selecione arquivos** e envie

### Argumentos de linha de comando

| Argumento | Descrição |
|---|---|
| `--bind <ip:porta>` | Endereço de escuta (padrão: detectado automaticamente) |
| `--peer <ip:porta>` | Conectar a este endereço ao iniciar |
| `--profile <nome>` | Carregar perfil salvo |
| `--profile-save <nome>` | Salvar conexão atual como perfil |
| `--profile-delete <nome>` | Deletar perfil |
| `--profile-alias <label>` | Nome amigável para o peer |
| `--peer-key <chave>` | Chave pública esperada do peer (verificação de identidade) |
| `--list-profiles` | Listar perfis salvos e sair |

### Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `PASTA_P2P_BIND` | Sobrescreve o endereço de bind padrão |
| `PASTA_P2P_STUN` | Lista de servidores STUN separados por vírgula, ou `off` para desabilitar |
| `HOLLOW_CHUNK_SIZE` | Tamanho do chunk de transferência em bytes |

---

## Funcionalidades

- **Transferência direta** — sem relay, sem nuvem, os dados não passam por terceiros
- **QUIC + TLS** — conexão criptografada com certificado gerado localmente
- **NAT traversal** — detecta seu IP público via STUN automaticamente
- **Retomada de transferências** — se a conexão cair no meio de um arquivo grande, continua de onde parou
- **Envio paralelo** — múltiplos arquivos enviados em streams QUIC simultâneos
- **Perfis** — salve endereços de peers frequentes com alias e chave de verificação
- **Identidade por chave pública** — cada instância gera um par Ed25519 persistente; você pode verificar a identidade do peer pela fingerprint
- **IPv4 e IPv6** — detecta a família de endereço disponível automaticamente; troca ao conectar em peer de família diferente

---

## Redes e NAT

O Hollow funciona melhor quando pelo menos um dos lados tem IP público ou está com a porta UDP liberada no roteador.

Para redes com NAT estrito:
- Abra/redirecione a porta UDP usada (visível na UI em "UDP &lt;porta&gt;")
- Ou use `--bind 0.0.0.0:<porta>` para fixar a porta e configurar port forwarding

Em redes locais (LAN), o STUN não é necessário — a UI cai automaticamente para o IP local quando STUN não está disponível.

---

## Perfis

Perfis ficam em:
- **Linux/macOS:** `~/.config/pasta_p2p/profiles.json`
- **Windows:** `%APPDATA%\pasta_p2p\profiles.json`

```bash
# Salvar
Hollow --peer 203.0.113.42:3000 --profile-alias "servidor casa" --profile-save casa

# Usar depois
Hollow --profile casa
```

---

## Build

Requer Rust 1.85+ (edition 2024).

```bash
cargo build --release
```

O binário fica em `target/release/Hollow` (Linux/macOS) ou `target\release\Hollow.exe` (Windows).

---

## Licença

MIT
