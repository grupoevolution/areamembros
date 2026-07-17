// DIA 0 — Parte 2: almoço → fim de tarde (11:30–19:00)
module.exports = ({ A, AM, F, V, VO, G, D, CTA }) => [

    // ── ALMOÇO ───────────────────────────────────────────────────────────────
    D('11:38', [
        [1, 'f', 'que fome gente, ainda nem decidi o almoço'],
        [2, 'm', 'vem almoçar aqui em casa, faço até sobremesa kk'],
        [1, 'f', 'sei bem qual sobremesa vc tá pensando kkkk'],
        [3, 'f', 'kkkkk esse grupo não consegue falar de comida sem segundas intenções'],
        [2, 'm', 'impossível, a culpa é de vcs kkkk'],
    ]),
    A('11:45', 'oi 🙈 sou a {nome}, {idade} anos, casada... no meu horário de almoço agora, o único momento de paz kkk', [
        ['f', 'bem vinda {nome1}! paz aqui vc não vai ter, mas diversão sim kkkk'],
        ['m', 'bem vinda gata, aproveita o horário kk'],
    ]),
    F('11:52', 'sexy', 'me arrumando pra sair pro almoço... exagerei? 🙈', [
        ['m', 'exagerou na perfeição só'],
        ['f', 'amiga desse jeito o restaurante para kkkk'],
    ]),
    A('12:03', 'oii gente, {nome}, {idade} anos, solteira, personal trainer 🙈 me falaram que aqui é movimentado', [
        ['m', 'personal?? o grupo inteiro vai querer treinar agora kkkk'],
        ['f', 'bem vinda {nome1} 😍 já tô querendo aula'],
    ]),
    D('12:15', [
        [1, 'f', 'almoçinho feito: macarrão na manteiga pq hoje eu tô preguiçosa kkk'],
        [2, 'm', 'casa comigo que eu como até macarrão queimado'],
        [1, 'f', 'kkkk baixou o padrão hein, era pra dizer que eu cozinho bem'],
        [3, 'f', 'meu almoço foi marmita fria no trabalho, inveja de vcs'],
        [4, 'm', 'marmita fria é foda {nome3}, te devo um almoço decente'],
        [3, 'f', 'anotado hein... eu cobro 😏'],
    ]),
    G('12:27', 3, 1, 'um presentinho de almoço pra vcs não me esquecerem à tarde 🙈🔥', [
        ['m', 'MEU DEUS que galeria'],
        ['m', 'esquecer?? impossível depois dessa'],
        ['f', 'amiga vc acorda e escolhe o caos kkkkk'],
    ]),
    A('12:40', 'oi amores 🙈 sou a {nome}, {idade} anos, casada, de {cidade}... cansada da rotina, vim me distrair', [
        ['f', 'bem vinda {nome1}!! distração é nosso sobrenome kkk'],
        ['m', 'de {cidade}? tô nessa região direto 👀 bem vinda'],
        ['f', 'a rotina acaba aqui amiga kkk'],
    ]),
    D('12:52', [
        [1, 'm', 'esse horário pós almoço devia ser proibido de tão arrastado'],
        [2, 'f', 'nem me fala, bateu aquela moleza'],
        [1, 'm', 'moleza se cura com café ou com emoção kk'],
        [2, 'f', 'prefiro a emoção... surpreende aí kkkk'],
    ]),
    V('13:04', 4, 'pra espantar o sono da tarde de vcs 🔥 de nada', [
        ['m', 'sono?? que sono, tô ACORDADÍSSIMO'],
        ['m', 'a melhor parte do meu dia até agora'],
    ]),
    A('13:16', 'oi gente, me chamo {nome}, {idade} anos, viúva... me disseram que aqui eu ia sorrir de novo kkk', [
        ['f', 'bem vinda {nome1} 🥰 aqui vc vai sorrir e MUITO'],
        ['m', 'seja muito bem vinda, o grupo é seu'],
    ]),
    D('13:27', [
        [1, 'f', 'voltando pro trabalho... me desejem paciência'],
        [2, 'm', 'paciência não, te desejo um chefe mudo kkkk'],
        [1, 'f', 'kkkkk aceito os dois'],
    ]),

    // ── TARDE / TRABALHO ─────────────────────────────────────────────────────
    F('13:39', 'trabalho', 'selfie do banheiro do trabalho pq o tédio venceu 🙈', [
        ['m', 'o banheiro mais sortudo do brasil'],
        ['f', 'kkkk amiga eu faço igual, banheiro é nosso estúdio'],
    ]),
    D('13:52', [
        [1, 'f', 'reunião marcada pras 14h de novo... me matem'],
        [2, 'm', 'finge que a internet caiu kkkk'],
        [1, 'f', 'vou fingir que caiu e ficar aqui com vcs kkkk'],
        [3, 'f', 'faz isso que a gente te entretém melhor que o chefe kkk'],
    ]),
    A('14:05', 'oii, sou a {nome}, {idade} anos, casada... trabalho home office e o tédio me trouxe aqui kkk', [
        ['f', 'bem vinda {nome1}! home office + esse grupo = produtividade zero kkkk'],
        ['m', 'bem vinda, o tédio acabou agora kk'],
    ]),
    F('14:18', 'trabalho', 'pausa do café... e esse uniforme que vcs pediram tanto 🙈', [
        ['m', 'o uniforme mais bem usado que eu já vi'],
        ['m', 'que pausa abençoada'],
    ]),
    D('14:31', [
        [1, 'f', 'gente uma cliente acabou de me contar uma fofoca que eu tô PASSADA'],
        [2, 'f', 'conta conta conta'],
        [1, 'f', 'a mulher descobriu que o marido tinha outra família em outra cidade'],
        [3, 'm', 'caraca kkkk como esconde uma família inteira'],
        [2, 'f', 'homem esconde até demais quando quer viu kkkk'],
        [1, 'f', 'por isso que eu digo: melhor ser a diversão que a enganada kkkk'],
    ]),
    AM('14:44', 'fala pessoal, {nome}, {idade} anos, empresário, separado há pouco tempo... conhecendo o grupo', [
        ['f', 'bem vindo {nome1}... empresário e livre, perigoso kkk'],
        ['f', 'gostei da energia dele 👀 bem vindo'],
    ]),
    A('14:52', 'oi 🙈 {nome}, {idade} anos, casada mas em crise kkk vim ver se distraio a cabeça', [
        ['f', 'bem vinda {nome1}, crise se cura com risada... e outras coisas kkk'],
        ['m', 'chegou na hora certa, bem vinda'],
    ]),
    V('15:03', 3, 'minha tarde tá lenta então toma... pra acelerar a de vcs 😈', [
        ['m', 'acelerou TUDO aqui kkkk'],
        ['f', 'kkkk amiga o grupo não merecia tanto'],
    ]),
    A('15:15', 'oii gente, sou a {nome}, tenho {idade} anos, professora, solteira... uma aluna nada a ver me indicou KKKK', [
        ['f', 'KKKKK a aluna indicou a professora, esse grupo não tem limite. bem vinda!'],
        ['m', 'professora?? o grupo vai estudar hoje kkkk bem vinda'],
    ]),
    D('15:21', [
        [1, 'f', 'sério que a {nome2} sumiu de novo bem na melhor hora'],
        [2, 'f', 'apareci!! tava trabalhando, ao contrário de vcs kkkk'],
        [3, 'm', 'trabalhando ou "trabalhando"? kkkk'],
        [2, 'f', 'as duas coisas 😏 depois conto'],
    ]),

    // ── CONFISSÃO DA TARDE ───────────────────────────────────────────────────
    D('15:34', [
        [1, 'f', 'CONFISSÃO DA TARDE: hoje eu quero ouvir dos casados... qual foi a maior loucura que já fizeram escondido?'],
        [2, 'f', 'começo eu: já saí "pra farmácia" e voltei 3 horas depois kkkk'],
        [3, 'm', 'já criei uma conta fake só pra seguir uma pessoa kkkk'],
        [4, 'f', 'já falei que tava no plantão e tava... bem acompanhada 🙈'],
        [2, 'f', 'A {nome4} GANHOU kkkkkkk'],
        [5, 'm', 'esse grupo é um perigo, anotando as técnicas kkkk'],
        [1, 'f', 'kkkkk e ainda são 15h30, imagina o que sai à noite'],
    ]),
    VO('15:47', 'foto', 'confissão merece recompensa... visualização única pros corajosos 🙈', [
        ['m', 'vi. confesso mais coisa se vier outra kkkk'],
        ['m', 'perdi de novo!!! qual o segredo de vcs'],
    ]),
    A('15:58', 'oi gente 🙈 sou a {nome}, {idade} anos... casada, dois filhos, e MUITO entediada kkk', [
        ['f', 'bem vinda {nome1}! mãe cansada merece diversão em dobro kkk'],
        ['m', 'bem vinda, aqui o tédio não sobrevive'],
    ]),
    F('16:08', 'trabalho', 'fim de expediente chegando... última do trabalho 🙈', [
        ['m', 'trabalho devia ser sempre assim'],
        ['f', 'arrasa no expediente e fora dele kkk'],
    ]),
    A('16:20', 'oii amores, {nome}, {idade} anos, solteira, de {cidade} 🙈 cansei de app de namoro, vim pro que presta', [
        ['m', 'de {cidade}!!! agora ficou interessante demais kkkk bem vinda'],
        ['f', 'bem vinda {nome1}, app de namoro é passado kkk'],
        ['m', 'o que presta agradece a preferência kkkk'],
    ]),
    D('16:33', [
        [1, 'm', 'reta final do expediente... hoje o grupo tá especialmente bom'],
        [2, 'f', 'e olha que nem começou a melhor parte 👀'],
        [1, 'm', 'como assim? o que vem aí?'],
        [2, 'f', 'quem fica online à noite descobre 😏'],
    ]),
    VO('16:45', 'video', 'um vídeo que eu JAMAIS deixaria fixo aqui... corre 🙈', [
        ['m', 'eu vi e preciso de um copo dágua'],
        ['m', 'chegar atrasado nesse grupo é um castigo'],
    ]),
    F('16:57', 'sexy', 'aquecendo pro fim do dia 🔥 tô no clima já', [
        ['m', 'clima?? isso é um furacão'],
        ['f', 'amiga tá impossível hoje kkkk'],
    ]),
    A('17:08', 'oi gente, me chamo {nome}, {idade} anos, recém separada... amigas disseram que eu precisava disso kkk', [
        ['f', 'bem vinda {nome1}!! suas amigas são sábias kkk'],
        ['m', 'recém separada e já no melhor lugar, bem vinda 😍'],
    ]),
    D('17:19', [
        [1, 'f', 'contando os minutos pra sair do trabalho'],
        [2, 'm', 'e depois do trabalho, quais os planos? kk'],
        [1, 'f', 'banho, comida e esse grupo... nessa ordem kkk'],
        [3, 'f', 'roteiro perfeito, o meu é igual kkkk'],
        [2, 'm', 'dois banhos acontecendo hoje e nós aqui... imaginando kkk'],
    ]),

    // ── SAÍDA DO TRABALHO / CHEGANDO EM CASA ─────────────────────────────────
    D('17:36', [
        [1, 'f', 'LIVREEE, expediente encerrado 🙌'],
        [2, 'f', 'liberdade!! agora começa o dia de verdade kkk'],
        [3, 'm', 'agora sim o grupo vai ferver'],
        [1, 'f', 'me aguardem que hoje eu tô diferente 😏'],
    ]),
    F('17:48', 'sexy', 'cheguei em casa e a primeira coisa foi tirar o sutiã e essa foto kkk', [
        ['m', 'a melhor tradição brasileira'],
        ['m', 'que chegada TRIUNFAL'],
    ]),
    A('17:59', 'oii, sou a {nome}, {idade} anos, casada... marido só chega tarde, então a noite é minha kkk', [
        ['f', 'bem vinda {nome1}! noite sua e nossa kkkk'],
        ['m', 'o grupo agradece ao marido pelo horário kkkk bem vinda'],
    ]),
    V('18:11', 4, 'esquenta oficial da noite começando AGORA 🔥🔥', [
        ['m', 'começou o show kkkk'],
        ['m', 'hoje eu não saio daqui'],
        ['f', 'amiga assim vc mata os homens do grupo kkkk'],
    ]),
    D('18:24', [
        [1, 'f', 'banho tomado... cheirosa e sem planos, perigosa combinação'],
        [2, 'm', 'combinação perfeita vc quis dizer'],
        [1, 'f', 'depende do rumo da noite kkkk'],
        [3, 'f', 'o rumo desse grupo à noite a gente já sabe qual é kkkk'],
    ]),
    A('18:37', 'oi gente 🙈 {nome}, {idade} anos, dona de casa... meu momento é agora depois que todo mundo janta', [
        ['f', 'bem vinda {nome1}! o momento é seu e ninguém tasca kkk'],
        ['m', 'bem vinda, chegou na melhor hora do grupo'],
    ]),
    F('18:48', 'sexy', 'produzida sem motivo nenhum... ou com todos os motivos 🙈', [
        ['m', 'o motivo somos nós, aceita kkkk'],
        ['f', 'deusa demais pra um dia comum kkk'],
    ]),
    D('18:56', [
        [1, 'm', 'jantei correndo pra não perder o início da noite aqui kkkk'],
        [2, 'f', 'fez bem, hoje tem programação especial 👀'],
        [1, 'm', 'especial como? tô curioso'],
        [2, 'f', 'às 21h30 vc descobre... só digo isso kkkk'],
    ]),
];
