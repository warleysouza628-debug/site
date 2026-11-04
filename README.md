# FF LEGACY

Loja estática em HTML, CSS e JavaScript, preparada para GitHub Pages.

## Publicação

1. Abra **Settings → Pages** neste repositório.
2. Em **Build and deployment**, selecione **Deploy from a branch**.
3. Escolha a branch **main** e a pasta **/(root)** e salve.
4. Aguarde alguns minutos. A URL padrão será https://warleysouza628-debug.github.io/site/

## Antes de vender

- Os produtos e preços do catálogo são exemplos demonstrativos. Edite a lista `products` no final de `index.html`.
- Carrinho e pré-pedidos são armazenados apenas no navegador do visitante.
- O checkout Pix ainda NÃO está integrado e não recebe pagamentos.
- Para cobrar Pix de verdade, será necessário um backend/servidor, credenciais privadas da gateway guardadas como secrets e validação do pagamento por webhook. Nunca coloque chaves secretas no HTML ou JavaScript público.
- Não anuncie produtos demonstrativos como se fossem ofertas reais.

## Arquivos

- `index.html`: interface, estilos e funcionalidades do catálogo/carrinho.
