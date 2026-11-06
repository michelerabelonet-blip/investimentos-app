# Investimentos — comparar ações

App web que busca empresas da B3 pelo nome (ex.: "itaú" → ITUB4, ITUB3, ITSA4) e compara a rentabilidade em 2, 5 ou 10 anos, com ou sem dividendos, contra o Ibovespa e o IPCA.

- Cotações e proventos: [brapi.dev](https://brapi.dev) (requer plano pago para histórico longo e dividendos)
- IPCA: API SGS do Banco Central (série 433)

## Rodar no Render
- Runtime: Node
- Build: `npm install`
- Start: `node server.js`
- Variável de ambiente: `BRAPI_TOKEN` = sua chave da brapi.dev

## Relatório do grupo de WhatsApp (aba "Grupo D2")
O WhatsApp não tem API oficial para ler grupos de uma conta pessoal, então o app usa a conversa exportada:
1. No grupo, **Exportar conversa → Sem mídia**.
2. Android com o app instalado: escolha **Investimentos** no compartilhamento. iPhone: salve em Arquivos e use "Importar conversa" na aba.
3. Faça isso uma vez por dia. A exportação traz o histórico inteiro e o app atualiza cada dia (guarda os últimos 60).

O relatório do dia mostra resumo, assuntos (com trechos), ativos citados, perguntas (e se tiveram resposta), enquetes, mensagens mais completas, links e participação, além de um botão para copiar o resumo. É feito por contagem de palavras, sem IA.
- Às 20h (Brasília) o agendamento `.github/workflows/grupo-resumo.yml` chama `/api/grupo/resumo-diario`, que manda uma notificação com o resumo do dia (ou um lembrete para exportar, se a conversa de hoje ainda não chegou). Usa as mesmas notificações dos alertas (`VAPID_PUBLIC`/`VAPID_PRIVATE`), no máximo uma por dia. O último resumo também aparece num card na aba Mercado.
- `GRUPO_NOME` (opcional): nome do grupo aceito na importação. Padrão: "D2 Estudos de Finanças e Investimentos".
- Use `APP_PIN` para proteger a aba e `DATABASE_URL` para os relatórios não sumirem quando o Render reiniciar.

Informativo, não é recomendação de investimento.
