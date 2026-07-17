// Temas dos 10 grupos novos. Cada um: id do grupo, apres (apresentações),
// caps (legendas de foto), vonce (textos de visu única), saud (cenas de
// saudação com vonce isca). Reusam o acervo de mídia do VIP.
module.exports = {
'CLUBE DAS CASADAS': { id: 3, femOnly: true,
  apres: ['oi 🙈 {nome}, {idade} anos, CASADA... e procurando o que falta em casa','{nome}, {idade}, casada há tempo demais kkk marido não me toca mais 😔🔥','oii {nome}, {idade} anos, casada de {cidade}... ele viaja muito e eu fico sozinha 😏','{nome}, {idade}, casada mas o coração (e o resto) tá livre 🙈','sou a {nome}, {idade}, casada e MUITO entediada... alguém me distrai?'],
  caps: ['meu marido no trabalho e eu assim ó 🙈','casada não é morta viu kkk','o que ele não vê não dói né? 😏','tédio de casada é perigoso 🔥','se ele soubesse que eu mando isso aqui kkkk'],
  vonce: ['só pra quem sabe guardar segredo de casada 🙈','isso aqui meu marido nunca viu 😏','casadinha safada mandando lembrança 🔥'],
  saud: [['gente chegou homem novo 👀 será que ele curte casada? 🙈'],['adoro homem que não tem medo de mulher casada 😏']] },

'GRUPINHO DOS CORNOS': { id: 4, femOnly: false,
  apres: ['oi 🙈 {nome}, {idade}... meu marido AMA me ver com outros 😈','{nome}, {idade} anos, casada... ele filma e adora kkk corno assumido','sou a {nome}, {idade}, de {cidade}... meu marido é do tipo que gosta de dividir 👀🔥','{nome}, {idade}, o corno aqui do lado autoriza tudo kkkk'],
  caps: ['ele tirou essa foto e mandou eu postar kkk','corno feliz é assim ó 😈','meu marido aprova cada foto dessas 🔥','ele adora quando vocês elogiam 👀'],
  vonce: ['o corno mandou eu mostrar pra vocês 😈','ele filmou e liberou... corre 🙈','autorizado pelo marido kkkk 🔥'],
  saud: [['chegou mais um... será corno ou vai querer ser? kkkk 😈'],['bem vindo! aqui a regra é uma só: sem ciúmes 🔥']] },

'VIZINHAS SAFADAS': { id: 5, femOnly: true,
  apres: ['oi vizinho 🙈 {nome}, {idade}, aqui de {cidade}... a gente é mais perto do que imagina 👀','{nome}, {idade} anos, moro pertinho de você... quem sabe a gente se esbarra 😏','sou a {nome}, {idade}, de {cidade} 🔥 procurando alguém aqui do bairro','oii {nome}, {idade}... será que você é meu vizinho? kkk 🙈'],
  caps: ['a vizinha que você sempre quis ter 😏','de {cidade} pra quem tá perto 📍🔥','tomara que meu vizinho veja isso kkk','morando pertinho e mandando isso 👀'],
  vonce: ['só pros vizinhos de {cidade} 🙈','se você é daqui perto, corre ver 📍','vizinho safado vai gostar dessa 🔥'],
  saud: [['gente será que ele é daqui de perto? 👀 tomara 🙈'],['bem vindo vizinho... você é de {cidade}? 😏']] },

'SÓ VALE NUDES': { id: 6, femOnly: true,
  apres: ['oi 🙈 {nome}, {idade}... aqui eu não tenho vergonha de nada 🔥','{nome}, {idade} anos, e adoro mandar nude 😈 sem frescura','sou a {nome}, {idade}, de {cidade}... vim mostrar tudo mesmo 🙈','{nome}, {idade}, nudes é comigo mesmo kkk 🔥'],
  caps: ['sem censura, do jeito que vocês gostam 🔥','nude do dia entregue 🙈','aqui é só o que interessa 😈','pra que roupa né? kkk'],
  vonce: ['a nude mais pesada de hoje 🙈🔥','só os rápidos veem essa 😈','sem censura por 1 visualização 👀'],
  saud: [['chegou gente nova pra ver minhas nudes 🙈🔥'],['bem vindo! aqui é nude o dia inteiro 😈']] },

'NOVINHAS +18': { id: 7, femOnly: true,
  apres: ['oii 🙈 {nome}, {idade} aninhos... recém no +18 e curiosa 🔥','{nome}, {idade}, novinha de {cidade}... me ensina as coisas? 😏','sou a {nome}, tenho {idade}, e adoro homem mais experiente 👀','{nome}, {idade} aninhos 🙈 primeira vez num grupo desses'],
  caps: ['novinha e sem vergonha kkk 🙈','{idade} aninhos de pura safadeza 🔥','olha o que a novinha aprontou 😏','recém no +18 e já assim ó 👀'],
  vonce: ['a novinha mandou e apagou correndo 🙈','só pra quem gosta de novinha 🔥','{idade} aninhos em visualização única 😈'],
  saud: [['chegou um mais velho pra ensinar a novinha? 🙈👀'],['bem vindo! adoro homem experiente 😏']] },

'ENCONTROS & SEXO': { id: 8, femOnly: true,
  apres: ['oi 🙈 {nome}, {idade}, de {cidade}... cansei de conversa, quero MARCAR 🔥','{nome}, {idade} anos... sem enrolação, quero encontrar alguém hoje 😈','sou a {nome}, {idade}, de {cidade} 📍 procurando encontro de verdade','{nome}, {idade}... papo é bom mas encontro é melhor 😏'],
  caps: ['pronta pra marcar com quem merecer 🔥','de {cidade}, disponível pra encontro 📍','chega de tela, bora ao vivo? 😈','quem é de {cidade} e quer marcar? 👀'],
  vonce: ['pra quem tá afim de marcar de verdade 🔥','só pros que querem encontro 😈','uma amostra do que te espera 🙈'],
  saud: [['chegou alguém pra marcar? 👀 você é de {cidade}? 🔥'],['bem vindo! aqui é pra marcar de verdade 😈']] },

'CRENTES SAFADAS': { id: 10, femOnly: true,
  apres: ['oi 🙈 {nome}, {idade}... crente de dia, safada de noite kkk','{nome}, {idade} anos, do culto pro pecado num piscar 😈','sou a {nome}, {idade}, de {cidade}... deus me perdoe mas eu adoro kkk 🔥','{nome}, {idade}, recatada lá fora... aqui nem tanto 🙈'],
  caps: ['deus me perdoe por essa foto kkk 🙈','recatada é modo de dizer 😏','do culto direto pro grupo 🔥','a irmã aqui apronta viu kkkk'],
  vonce: ['perdão senhor mas vocês precisam ver 🙈','a crente safada atacou 😈','só entre nós, deus não tá vendo kkk 🔥'],
  saud: [['chegou um irmão... será que aguenta uma crente safada? 🙈😈'],['bem vindo ao culto do pecado kkk 🔥']] },

'PUTARIA 24H': { id: 11, femOnly: true,
  apres: ['oi 🙈 {nome}, {idade}... aqui não tem hora pra parar 🔥','{nome}, {idade} anos, disponível 24 horas 😈 nunca durmo','sou a {nome}, {idade}, de {cidade}... putaria é dia e noite 🙈','{nome}, {idade}, qualquer hora é hora comigo kkk 🔥'],
  caps: ['3 da manhã e eu aqui ó 🙈','não importa a hora, sempre safada 🔥','putaria não tem horário 😈','acordada e perigosa a qualquer hora 👀'],
  vonce: ['24h de putaria em 1 visualização 🙈','qualquer hora tem, corre 🔥','não durmo, e você? 😈'],
  saud: [['chegou gente a essa hora? aqui não para nunca 😈🔥'],['bem vindo! aqui é putaria 24 horas 🙈']] },

'NAMORO E AMIZADE': { id: 12, femOnly: true,
  apres: ['oii 🙈 {nome}, {idade}, de {cidade}... cansei de ficar sozinha, quero namorar ❤️','{nome}, {idade} anos... procuro alguém pra conversar e quem sabe mais 😊🔥','sou a {nome}, {idade}, de {cidade}... quero um amor de verdade (ou uma aventura kkk)','{nome}, {idade}, carente assumida 🥺 me dá atenção?'],
  caps: ['procurando alguém especial 🥺❤️','carente hoje... alguém pra conversar? 🙈','queria um abraço (e mais um pouco kkk) 🔥','de {cidade}, sozinha, esperando você 😊'],
  vonce: ['pra quem me der atenção de verdade 🙈❤️','uma prévia pro meu futuro namorado 😏','só pra quem quer algo comigo 🔥'],
  saud: [['chegou alguém... será meu futuro namorado? 🥺❤️'],['bem vindo! tô procurando algo sério... ou não kkk 😏']] },

'SO PRA CONVERSAR': { id: 9, femOnly: true,
  apres: ['oii 🙈 {nome}, {idade}, de {cidade}... só quero um papo bom, sem pressão 😊','{nome}, {idade} anos... cansei de gente sem assunto, vim conversar de verdade','sou a {nome}, {idade}, de {cidade}... adoro uma boa conversa antes de qualquer coisa 😏','{nome}, {idade}, carente de atenção kkk alguém pra trocar ideia?'],
  caps: ['bom papo vale mais que tudo 😊','conversa boa me ganha viu 🙈','tô aqui só pra trocar ideia... por enquanto 😏','quem puxa assunto legal leva vantagem 👀'],
  vonce: ['pra quem me conquistou no papo 🙈','conversou bem? ganhou isso 😏','só pra quem sabe conversar 🔥'],
  saud: [['chegou alguém pra conversar? adoro gente de papo 😊'],['bem vindo! aqui a conversa vem antes... mas vem tudo depois 😏']] },

'GRUPO VIP': { id: 2, skip: true },
};
