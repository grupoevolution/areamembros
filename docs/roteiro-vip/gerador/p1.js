// DIA 0 — Parte 1: madrugada → fim da manhã (00:00–11:30)
module.exports = ({ A, AM, F, V, VO, G, D, CTA }) => [

    // ── MADRUGADA ────────────────────────────────────────────────────────────
    D('00:06', [
        [1, 'f', 'quem tá acordado ainda 👀'],
        [2, 'm', 'eu... e sem sono nenhum'],
        [3, 'f', 'eu tbm, marido apagou faz uma hora e eu aqui olhando o teto'],
        [2, 'm', 'olhando o teto ou o grupo {nome3}? kkkk'],
        [3, 'f', 'os dois ué kkkk um é mais interessante que o outro 🙈'],
    ]),
    VO('00:14', 'video', 'só pra quem tá acordado AGORA... quem dormiu perdeu 🙈', [
        ['m', 'MANO. que isso'],
        ['m', 'eu sabia que valia a pena ficar acordado kkkk'],
    ]),
    D('00:26', [
        [1, 'f', 'gente confesso que a madrugada me deixa diferente'],
        [2, 'm', 'diferente como? explica isso direito kk'],
        [1, 'f', 'mais corajosa... de dia eu jamais falaria o que penso agora'],
        [3, 'm', 'então fala, aqui ninguém julga kkkk'],
        [1, 'f', 'quem sabe daqui a pouco... vou ver se o grupo merece 😏'],
    ]),
    V('00:38', 3, 'toma, um esquenta pra quem não consegue dormir 🔥', [
        ['m', 'agora que não durmo mesmo'],
        ['f', 'amiga vc não tem limite kkkkk'],
    ]),
    A('00:52', 'oi gente 🙈 {nome}, {idade} anos, casada... entrei agora e já vi que esse grupo não dorme kkk', [
        ['f', 'bem vinda {nome1}!! aqui a madrugada é o melhor horário'],
        ['m', 'chegou madrugadora nova kkkk seja bem vinda'],
    ]),
    D('01:03', [
        [1, 'f', 'confissão da madrugada: hoje sonhei com uma pessoa daqui e acordei pensando nela'],
        [2, 'm', 'como assim, conta quem'],
        [1, 'f', 'jamais kkkk mas foi um sonho... intenso'],
        [3, 'f', 'kkkkk eu sei quem é, ela me contou no pv'],
        [2, 'm', 'AGORA eu preciso saber'],
        [1, 'f', '{nome3} se vc abrir a boca eu te bloqueio kkkkk'],
    ]),
    VO('01:15', 'foto', 'isso aqui some rápido... quem tá on corre 🙈', [
        ['m', 'corri e valeu MUITO a pena'],
        ['m', 'como assim eu cliquei e já era???'],
    ]),
    D('01:28', [
        [1, 'f', 'ser casada e estar acordada 1h da manhã num grupo desses... me julguem'],
        [2, 'f', 'amiga se te julgarem me julgam junto kkkk'],
        [3, 'm', 'ninguém julga, a gente agradece kkkk'],
        [1, 'f', 'o pior é que eu nem me arrependo 🙈'],
        [2, 'f', 'arrepender é pra quem faz pouco kkkkk'],
    ]),
    F('01:41', 'sexy', 'sem sono... aproveitei pra tirar essa. julguem 🙈', [
        ['m', 'julgado: 10/10'],
        ['m', 'a insônia te fez um favor viu'],
    ]),
    D('01:55', [
        [1, 'm', 'esse grupo de madrugada é outro nível'],
        [2, 'f', 'de dia a gente se comporta... um pouco kkk'],
        [1, 'm', 'então amanhã de madrugada eu tô aqui de novo'],
        [2, 'f', 'te espero 😏'],
    ]),
    A('02:08', 'oii, sou a {nome}, {idade} anos, solteira... insônia me trouxe pra cá kkk', [
        ['f', 'bem vinda {nome1}! a insônia trouxe, o conteúdo segura kkkk'],
        ['m', 'mais uma pro clube dos sem sono, bem vinda'],
    ]),
    D('02:21', [
        [1, 'f', 'vou tentar dormir vai... amanhã tem mais'],
        [2, 'm', 'boa noite gata, sonha comigo kk'],
        [1, 'f', 'se comportar talvez kkkk 😘'],
    ]),

    // ── VALE DA MADRUGADA ────────────────────────────────────────────────────
    D('03:47', [
        [1, 'm', 'alguém vivo nesse horário?'],
        [2, 'f', 'eu, plantão... a madrugada é longa demais sozinha'],
    ]),
    D('05:19', [
        [1, 'f', 'acordando pro plantão... o grupo tá quieto até demais'],
        [2, 'm', 'quieto não, descansando pra hoje kkk'],
        [1, 'f', 'gostei... hoje promete então 👀'],
    ]),
    A('06:12', 'bom dia 🙈 sou a {nome}, {idade} anos, casada, madrugadora... me indicaram esse grupo ontem', [
        ['f', 'bem vinda {nome1}!! chegou cedo, vai pegar o dia inteiro kkk'],
        ['m', 'bom dia e bem vinda 😍'],
    ]),
    D('06:24', [
        [1, 'm', 'acordado desde as 5 pra trabalhar... vida dura'],
        [2, 'f', 'coitado kkkk toma um café que hoje o dia vai ser bom'],
        [1, 'm', 'com vcs aqui todo dia é bom'],
    ]),

    // ── BOM DIA ──────────────────────────────────────────────────────────────
    D('06:41', [
        [1, 'f', 'bom diaaaa grupo 🌞'],
        [2, 'f', 'bom dia amoress'],
        [3, 'm', 'bom dia gatas'],
        [4, 'f', 'bom dia gente!! acordei agora kkk'],
        [2, 'f', 'hoje eu acordei elétrica, avisando logo'],
        [5, 'm', 'elétrica como {nome2}? kkkk'],
    ]),
    F('06:53', 'bom-dia', 'bom dia direto da minha cama... ainda com preguiça 🙈', [
        ['m', 'que jeito bom de começar o dia'],
        ['m', 'essa preguiça te deixou linda'],
    ]),
    A('07:07', 'oi gente, {nome}, {idade} anos, divorciada e muito bem kkk vim conhecer', [
        ['f', 'bem vinda {nome1}! divorciada e feliz é o espírito daqui kkk'],
        ['m', 'seja bem vinda 😍'],
    ]),
    D('07:16', [
        [1, 'f', 'acordei pensando numa coisa que não dá pra falar às 7 da manhã kkkk'],
        [2, 'm', 'fala que o grupo aguenta'],
        [1, 'f', 'o grupo aguenta mas o meu juízo não kkkk'],
        [3, 'f', 'amiga eu acordei igual, deve ser o clima de hoje'],
        [2, 'm', 'que clima é esse que eu quero entender kkkk'],
    ]),
    A('07:28', 'bom dia 🙈 sou a {nome}, {idade} anos, casada, de {cidade}... uma amiga vive falando desse grupo e vim ver', [
        ['f', 'bem vinda {nome1}!! sua amiga tem bom gosto kkk'],
        ['m', 'opa, de {cidade}?? agora o grupo ficou melhor ainda'],
        ['f', 'chegou vizinha kkkk bem vinda'],
    ]),
    F('07:39', 'bom-dia', 'café passado e essa carinha de sono ☕ bom dia', [
        ['m', 'bom dia... que vontade de tomar esse café aí do lado'],
        ['f', 'linda até recém acordada, tem dó'],
    ]),
    D('07:48', [
        [1, 'f', 'gente o pão da padaria hoje tava quentinho, dia já começou ganhando'],
        [2, 'm', 'e o padeiro, tava quentinho tbm? kkkk'],
        [1, 'f', 'kkkkkk o padeiro tem seus 60 anos, calma'],
        [3, 'f', 'depende, tem sessentão que tá melhor que muito novinho viu'],
        [2, 'm', 'a {nome3} falou e calou o grupo kkkkk'],
    ]),
    A('07:57', 'oii sou a {nome}, tenho {idade} anos, solteira... primeira vez num grupo assim, tô curiosa kkk', [
        ['f', 'bem vinda {nome1}! curiosidade aqui é bem recompensada kkk'],
        ['m', 'bem vinda, pergunta o que quiser kk'],
    ]),

    // ── MANHÃ / TRABALHO ─────────────────────────────────────────────────────
    D('08:09', [
        [1, 'm', 'preso no trânsito já... que cidade'],
        [2, 'f', 'eu de busão ainda por cima kkk'],
        [1, 'm', 'se eu te encontrasse no busão o trajeto ia ser melhor kk'],
        [2, 'f', 'atrevido logo cedo kkkk gostei'],
        [3, 'm', 'o grupo nem acordou direito e já tem flerte kkkk'],
    ]),
    F('08:22', 'bom-dia', 'última foto antes de sair de casa... aprovadas? 🙈', [
        ['m', 'aprovadíssima, trabalha não, fica em casa kk'],
        ['f', 'que look amiga 😍'],
    ]),
    A('08:34', 'bom dia gente 🙈 {nome}, {idade} anos, casada há 8... procurando o que não tenho em casa', [
        ['m', 'chegou direta kkkk bem vinda'],
        ['f', 'bem vinda {nome1}, aqui vc encontra kkk'],
    ]),
    D('08:47', [
        [1, 'f', 'chefe já me irritou e não são nem 9h'],
        [2, 'm', 'demite ele kkkk'],
        [1, 'f', 'quem me dera... vou descontar a raiva aqui no grupo mais tarde 😏'],
        [3, 'm', 'raiva descontada aqui vira presente pra nós kkkk'],
        [1, 'f', 'exatamente por isso que eu aviso kkkk'],
    ]),
    F('08:58', 'academia', 'treino de hoje PAGO 💪 quem mais treinou?', [
        ['m', 'depois dessa foto vou treinar agora mesmo'],
        ['f', 'shape em dia amiga, inveja boa 😍'],
    ]),
    A('09:12', 'oi amores, sou a {nome}, {idade} aninhos, solteira e sem paciência pra joguinho kkk', [
        ['f', 'bem vindaaa {nome1} 😍 sem joguinho é aqui mesmo'],
        ['m', 'gostei da apresentação kkkk bem vinda'],
        ['f', 'chegou decidida, o grupo agradece kkk'],
    ]),
    D('09:24', [
        [1, 'f', 'to no intervalo do trabalho só pra ver o que perdi'],
        [2, 'm', 'perdeu a madrugada que tava HISTÓRICA'],
        [1, 'f', 'sempre perco as melhores 😭 hoje eu fico acordada'],
        [3, 'f', 'fica mesmo, ouvi dizer que hoje vai ter surpresa 👀'],
    ]),
    D('09:37', [
        [1, 'f', 'meu marido viajou hoje cedo... casa silenciosa demais'],
        [2, 'm', 'silêncio é convite kkkk'],
        [1, 'f', 'interpreta como quiser 🙈'],
        [3, 'f', 'amiga aproveita, o meu tá aqui roncando no sofá o dia inteiro'],
        [2, 'm', 'a {nome3} sofrendo e o grupo lucrando kkkk'],
        [1, 'f', 'a semana vai ser longa... ou curta, depende de vcs 😏'],
    ]),
    A('09:51', 'oi gente 🙈 me chamo {nome}, {idade} anos, casada... entrei escondida dele kkk', [
        ['f', 'bem vinda {nome1} kkkk aqui todo mundo tem segredo, relaxa'],
        ['m', 'segredo guardado a sete chaves, bem vinda'],
    ]),
    V('10:04', 3, 'p/ animar a manhã de vcs 🔥 não me julguem', [
        ['m', 'julgar?? a gente AGRADECE'],
        ['m', 'minha produtividade no trabalho acabou agora kkkk'],
    ]),
    AM('10:17', 'e aí grupo, {nome}, {idade} anos, divorciado... me falaram bem daqui kk', [
        ['f', 'bem vindo {nome1} 👀 chegou elegante'],
        ['f', 'gostei desse aí kkk bem vindo'],
    ]),
    D('10:29', [
        [1, 'f', 'gente o novato já chegou catando kkkk'],
        [2, 'm', 'deixa o homem kkkk chegou com moral'],
        [3, 'f', 'moral tem que conquistar aqui dentro viu kkk'],
        [4, 'm', 'e como se conquista? pergunta séria kk'],
        [1, 'f', 'participando... e sabendo elogiar na hora certa 😏'],
    ]),
    F('10:42', 'sexy', 'nem é nem meio dia e eu já tô assim... socorro 🙈', [
        ['m', 'assim COMO? que foto é essa'],
        ['m', 'o dia nem esquentou e vc já derreteu o grupo'],
    ]),
    A('10:55', 'oii, {nome}, {idade} anos, casada, enfermeira... saindo do plantão e entrando na bagunça kkk', [
        ['f', 'bem vinda {nome1}!! enfermeira?? o grupo tá bem servido kkk'],
        ['m', 'plantão pesado merece recompensa, bem vinda 😍'],
    ]),
    D('11:07', [
        [1, 'f', 'quem tava aqui ontem à noite sabe do que eu tô falando kkkkk'],
        [2, 'm', 'eu tava e NÃO SUPEREI'],
        [3, 'f', 'eu perdi!!! alguém me conta pelo amor'],
        [1, 'f', 'quem viu viu, quem não viu que fique hoje até tarde kkkk'],
        [2, 'm', 'hoje eu não durmo, aprendi a lição'],
        [3, 'f', 'tá bom, hoje eu fico... mas é bom valer a pena viu kkk'],
    ]),
    VO('11:16', 'foto', 'mandei uma coisinha... só os atentos vão pegar 🙈', [
        ['m', 'PEGUEI. meu dia tá feito'],
        ['m', 'ah não, cliquei tarde demais 😭'],
    ]),
    A('11:26', 'oi gente, sou a {nome}, {idade} anos... amiga da {nome2}, ela me arrastou pra cá kkk', [
        ['f', 'chegou minha convidada!! grupo, tratem ela bem 😏'],
        ['m', 'amiga de {nome2} é da casa, bem vinda'],
        ['f', 'bem vindaa, se ela te trouxe é pq vc é do nível kkk'],
    ]),
];
