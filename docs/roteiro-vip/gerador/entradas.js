// RECEPÇÕES PRÓPRIAS POR GRUPO (02/11). Antes todos os grupos secundários
// usavam o MESMO esqueleto ("MEU DEUS que recepção kkkk", "esse grupo não
// existe kkkk", "de onde você é?") — só a 1ª frase mudava. Aqui cada grupo
// tem o próprio jeito de receber, de responder quando o lead fala (novato) e
// de reagir (reacao). Uso: node entradas.js <groupId> → imprime o JSON das
// cenas (importar em Grupos → cenas, substituindo).
// Formato da mensagem: p = pessoa da cena (1..4), g = f/m, t = tipo,
// gap_s = segundos depois da anterior. vonce = visualização única (pasta).
const T = (p, text, gap, g) => ({ p, g: g || 'f', t: 'text', text, gap_s: gap || 4 });
const V = (p, text, gap, kind) => ({ p, g: 'f', t: 'vonce', kind: kind || 'foto', folder: kind === 'video' ? 'videos-sexy' : 'sexy', text, gap_s: gap || 5 });
const S = (category, ...messages) => ({ category, period: 'any', weight: 1, messages });

const E = {
// 3 — CLUBE DAS CASADAS (o que mais vende): segredo, marido, discrição
3: [
  S('entrada', T(1, 'psiu… entrou alguém 👀 relaxa que aqui ninguém conta pro marido de ninguém kkk', 4), T(2, 'regra nº1 do clube: o que acontece aqui, MORRE aqui 🤫', 5), T(3, 'seja bem vindo… espero que você saiba guardar segredo 😏', 5)),
  S('entrada', T(1, 'aproveitando que meu marido saiu agora pouco… 🙈', 4), V(1, 'presente de boas vindas, mas apaga da memória depois kkk', 5), T(2, 'mulher você não tem jeito kkkk e se ele pega teu celular?', 5), T(1, 'pega nada, tá no futebol 😈', 4)),
  S('entrada', T(1, 'olha… sangue novo no clube 👀', 4), T(2, 'tomara que seja solteiro, casado já tenho um em casa que não me dá atenção kkkk', 5), T(3, 'você é casado ou solteiro? fala a verdade que aqui ninguém julga 😏', 6)),
  S('novato', T(1, 'aiii ele falou 🙈 gostei dele', 4), T(2, 'se for de {cidade} eu já começo a inventar desculpa pro meu marido kkk', 5)),
  S('novato', T(1, 'bem vindo moço 😏 tô curiosa: você curte mulher comprometida?', 4), T(2, 'responde com sinceridade que eu te mando uma coisinha 🙈', 5)),
  S('reacao', T(1, 'adorei 😏 homem que fala assim deixa casada pensando besteira', 4)),
  S('reacao', T(1, 'kkkkk tô rindo sozinha aqui e meu marido perguntando o que é', 4), T(2, 'fala que é o grupo da igreja kkkkk', 4)),
],
// 5 — VIZINHAS SAFADAS: proximidade, bairro, "te vi por aí"
5: [
  S('entrada', T(1, 'gente… acho que ele é daqui de {cidade} 👀📍', 4), T(2, 'sério? qual bairro? tô curiosa agora', 5), T(1, 'chega mais vizinho, aqui todo mundo mora pertinho 😏', 5)),
  S('entrada', T(1, 'chegou gente nova e eu de pijama aqui na janela 🙈', 4), V(1, 'olha a vista da sua vizinha hoje 😏', 5), T(2, 'kkkk ela recebe todo mundo assim, acostuma', 4)),
  S('entrada', T(1, 'opa, vizinho novo 👀 você é de {cidade} mesmo?', 4), T(2, 'se for do centro eu juro que já te vi no mercado kkkk', 5), T(3, 'manda o bairro aí que a gente vê quem mora mais perto 📍', 5)),
  S('novato', T(1, 'aaa então você é daqui mesmo 😍', 4), T(2, 'fica de olho que qualquer dia a gente se esbarra na padaria kkk', 5)),
  S('novato', T(1, 'oi vizinho 😏 que bom que você falou', 4), T(2, 'mora sozinho? pergunto por nada não kkkk 🙈', 5)),
  S('reacao', T(1, 'kkkk adoro vizinho falador 😏', 4)),
  S('reacao', T(1, 'é por isso que eu amo esse grupo, só gente de perto 📍🔥', 4)),
],
// 7 — NOVINHAS +18: curiosa, tímida, homem experiente
7: [
  S('entrada', T(1, 'aiii entrou um homem mais velho né? 🙈', 4), T(2, 'tomara 😳 os da minha idade não sabem de nada kkk', 5), T(1, 'bem vindo moço… me ensina as coisas? 🎀', 5)),
  S('entrada', T(1, 'oiii 🎀 vou ser corajosa e dar as boas vindas', 4), V(1, 'mandei e já tô morrendo de vergonha 🙈', 5), T(2, 'kkkk olha a novinha se soltando', 4)),
  S('entrada', T(1, 'gente tem homem novo aqui 😳', 4), T(2, 'quantos anos você tem moço? adoro homem experiente 👀', 5)),
  S('novato', T(1, 'aaa ele respondeu 🙈🎀', 4), T(2, 'fala mais, tô curiosa sobre você', 5)),
  S('novato', T(1, 'oiii 😳 você tem jeito de ser carinhoso', 4), T(2, 'ou é dos safados? kkkk responde', 5)),
  S('reacao', T(1, 'kkkk fiquei vermelha aqui 🙈', 4)),
  S('reacao', T(1, 'ai que fofo 🎀 continua', 4), T(2, 'ela tá caidinha já kkkk', 4)),
],
// 10 — CRENTES SAFADAS: culto, pecado, "deus não tá vendo"
10: [
  S('entrada', T(1, 'a paz do senhor irmão 🙏😇', 4), T(2, 'kkkkk começou com a paz e daqui a pouco é pecado', 5), T(1, 'seja bem vindo… aqui a gente ora de dia e peca de noite 😈', 5)),
  S('entrada', T(1, 'acabei de chegar do culto e já tô aqui kkk 🙈', 4), V(1, 'o vestidinho do culto… e depois do culto 😈', 5), T(2, 'irmã!!! kkkk deus tá vendo isso', 4), T(1, 'deus perdoa, o pastor que não pode saber 🤫', 4)),
  S('entrada', T(1, 'irmão novo na congregação 👀🙏', 4), T(2, 'você é crente também ou veio só pelo pecado? kkk', 6)),
  S('novato', T(1, 'glória 🙏 ele falou kkk', 4), T(2, 'conta, de qual igreja você é? ou tá desviado? 😏', 5)),
  S('novato', T(1, 'seja bem vindo irmão 😇', 4), T(2, 'aqui todo mundo tem um segredinho… qual é o seu? 🤫', 5)),
  S('reacao', T(1, 'amém kkkkk 🙏😈', 4)),
  S('reacao', T(1, 'misericórdia que homem 🙈', 4), T(2, 'ela vai ter que jejuar depois dessa kkkk', 4)),
],
// 9 — SÓ PRA CONVERSAR: papo, carência, atenção
9: [
  S('entrada', T(1, 'oi! que bom que chegou gente nova pra conversar 😊', 4), T(2, 'aqui é tranquilo, ninguém julga… pode chegar falando de qualquer coisa', 5), T(1, 'como foi seu dia hoje? 💬', 5)),
  S('entrada', T(1, 'eba, gente nova 😊 eu tava aqui sem ninguém pra trocar ideia', 4), T(2, 'conta um pouco de você… trabalha com o quê?', 5)),
  S('entrada', T(1, 'oii bem vindo 💬', 4), T(2, 'regra daqui: quem chega tem que contar uma coisa sobre si kkk', 5), T(3, 'eu começo: sou de {cidade} e tô carente hoje 🙈 sua vez', 5)),
  S('novato', T(1, 'aaa que legal 😊 adorei você', 4), T(2, 'e tá solteiro? pergunto só pra conversa render kkk', 5)),
  S('novato', T(1, 'gostei do seu jeito 💬', 4), T(2, 'fica por aqui, a gente conversa a noite inteira', 5)),
  S('reacao', T(1, 'verdade 😊 pensei a mesma coisa', 4)),
  S('reacao', T(1, 'kkkk você é engraçado, adoro', 4)),
],
// 4 — GRUPINHO DOS CORNOS: marido libera, sem ciúme
4: [
  S('entrada', T(1, 'amor, olha, chegou mais um 😈', 4, 'm'), T(2, 'é o meu marido kkkk ele que adora quando chega homem novo', 5), T(2, 'seja bem vindo… aqui ele assiste e eu me divirto 🔥', 5)),
  S('entrada', T(1, 'meu marido mandou eu dar as boas vindas 🙈', 4), V(1, 'foi ele que tirou essa foto 😈', 5), T(2, 'corno feliz é outra coisa kkkk', 4)),
  S('entrada', T(1, 'chegou alguém 👀 você é corno ou o comedor? kkkk', 4), T(2, 'sem vergonha, aqui tem dos dois 😈', 5)),
  S('novato', T(1, 'kkkk adorei a resposta', 4), T(2, 'meu marido falou que gostou de você 👀', 5)),
  S('novato', T(1, 'bem vindo de verdade 😈', 4), T(2, 'aqui a regra é uma só: sem ciúme 🔥', 5)),
  S('reacao', T(1, 'o corno aqui tá rindo kkkk', 4)),
  S('reacao', T(1, 'é disso que eu gosto 😈', 4)),
],
// 8 — ENCONTROS & SEXO: marcar, perto, hoje
8: [
  S('entrada', T(1, 'chegou alguém disposto a sair de casa? 👀', 4), T(2, 'porque aqui é encontro de verdade, chega de só tela 🔥', 5), T(1, 'você é de {cidade}? 📍', 5)),
  S('entrada', T(1, 'boa, mais um 😈', 4), V(1, 'o que te espera se a gente marcar 🙈', 5), T(2, 'ela não brinca em serviço kkk', 4)),
  S('entrada', T(1, 'bem vindo 🔥 sem enrolação: você tem carro ou eu que busco? kkkk', 4), T(2, 'kkkk calma mulher, deixa ele chegar', 5)),
  S('novato', T(1, 'gostei 😏 qual bairro de {cidade} você fica?', 4), T(2, 'quem sabe não é pertinho de mim 📍', 5)),
  S('novato', T(1, 'opa, ele falou 😈', 4), T(2, 'tá livre que dia da semana? pergunta séria kkk', 5)),
  S('reacao', T(1, 'é assim que se fala 🔥', 4)),
  S('reacao', T(1, 'kkkk já quero marcar com ele', 4)),
],
// 11 — PUTARIA 24H: sem hora, sem filtro
11: [
  S('entrada', T(1, 'chegou gente a essa hora 😈 aqui não fecha nunca', 4), T(2, 'bem vindo à putaria que não dorme 🔥', 5)),
  S('entrada', T(1, 'novato na área 👀', 4), V(1, 'pra você ver como é aqui 😈', 5), V(2, 'e essa é minha 🔥', 5, 'video'), T(3, 'kkkk vocês não perdoam ninguém', 4)),
  S('entrada', T(1, 'oi gostoso 😏 aqui é sem filtro', 4), T(2, 'fala aí o que você curte que a gente manda 🔥', 6)),
  S('novato', T(1, 'kkkk gostei do safado', 4), T(2, 'tá acordado até que horas hoje? 😈', 5)),
  S('novato', T(1, 'fala mais 🔥', 4), T(2, 'aqui quem é tímido não sobrevive kkk', 5)),
  S('reacao', T(1, 'isso aí 😈🔥', 4)),
  S('reacao', T(1, 'kkkk que homem', 4), T(2, 'já quero ver ele no privado', 4)),
],
// 12 — NAMORO E AMIZADE: carinho, romance
12: [
  S('entrada', T(1, 'oi 🥺 chegou alguém novo… será que é solteiro?', 4), T(2, 'aqui todo mundo tá procurando alguém especial ❤️', 5), T(1, 'seja muito bem vindo 😊', 5)),
  S('entrada', T(1, 'que bom ver gente nova ❤️', 4), T(2, 'você veio procurar namoro ou amizade? (ou os dois kkk)', 5)),
  S('entrada', T(1, 'oii 😊 sou meio carente, já aviso kkk', 4), V(1, 'uma fotinho minha pra você me conhecer 🙈', 5), T(2, 'ela tá procurando namorado faz tempo 🥺', 4)),
  S('novato', T(1, 'que fofo ❤️ gostei de você', 4), T(2, 'tá solteiro faz tempo?', 5)),
  S('novato', T(1, 'ai que bom que você falou 🥺', 4), T(2, 'me conta o que você procura numa mulher', 5)),
  S('reacao', T(1, 'que lindo isso ❤️', 4)),
  S('reacao', T(1, 'ai gente, tô apaixonada kkkk', 4)),
],
// 6 — SÓ VALE NUDES: mídia direto
6: [
  S('entrada', T(1, 'chegou mais um pra ver nude 🙈🔥', 4), V(1, 'boas vindas do jeito daqui', 5), T(2, 'regra do grupo: entrou, ganhou 😈', 4)),
  S('entrada', V(1, 'novato ganha logo a melhor 🙈', 4), V(2, 'e a minha tbm 🔥', 5, 'video'), T(3, 'kkkk gente, deixa ele respirar', 4)),
  S('entrada', T(1, 'oi 😏 aqui não tem conversa fiada, só nude', 4), T(2, 'qual você prefere: mais ousada ou mais delicada? 👀', 6)),
  S('novato', T(1, 'falou bonito, ganhou 🙈', 4), V(1, 'só pra você', 5)),
  S('novato', T(1, 'kkkk gostei 😈', 4), T(2, 'aqui quem participa ganha mais 🔥', 5)),
  S('reacao', T(1, '🔥🔥🔥', 3)),
  S('reacao', T(1, 'kkkk safado 😈', 4)),
],
// 14 — GRUPINHO DE {cidade}: gente da cidade, "acho que te conheço", bairro
14: [
  S('entrada', T(1, 'gente!! chegou alguém aqui de {cidade} 😍📍', 4), T(2, 'serio? tô achando que conheço kkkk', 5), T(1, 'qual bairro você mora? 👀', 5)),
  S('entrada', T(1, 'eita, mais um de {cidade} 👀', 4), T(2, 'esse grupo tá ficando bom, só gente daqui', 5), T(3, 'você mora pra qual lado da cidade? 📍', 5)),
  S('entrada', T(1, 'oi vizinho de cidade 😏', 4), V(1, 'presentinho de boas vindas, só pra quem é daqui 🙈', 5), T(2, 'kkkk ela recebe todo mundo assim', 4), T(3, 'fala o bairro aí que a gente vê se te conhece 😏', 5)),
  S('novato', T(1, 'aaa eu sei onde é 😍', 4), T(2, 'pertinho de mim kkk qualquer dia a gente se esbarra', 5)),
  S('novato', T(1, 'não acredito, é do lado da casa da minha tia kkkk', 4), T(2, 'cidade pequena demais 🙈', 5)),
  S('reacao', T(1, 'só gente boa de {cidade} aqui 😏📍', 4)),
  S('reacao', T(1, 'kkkk adoro gente daqui', 4)),
],
};
module.exports = E;
if (require.main === module) {
  const id = parseInt(process.argv[2], 10);
  process.stdout.write(JSON.stringify(E[id] || [], null, 1));
}
