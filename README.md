# Investimentos — comparar ações

App web que busca empresas da B3 pelo nome (ex.: "itaú" → ITUB4, ITUB3, ITSA4) e compara a rentabilidade em 2, 5 ou 10 anos, com ou sem dividendos, contra o Ibovespa e o IPCA.

- Cotações e proventos: [brapi.dev](https://brapi.dev) (requer plano pago para histórico longo e dividendos)
- IPCA: API SGS do Banco Central (série 433)

## Rodar no Render
- Runtime: Node
- Build: `npm install`
- Start: `node server.js`
- Variável de ambiente: `BRAPI_TOKEN` = sua chave da brapi.dev

Informativo, não é recomendação de investimento.
