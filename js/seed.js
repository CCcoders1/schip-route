// Voorbeelddata voor de Amadeus Aquamarijn (schematisch, aan te passen in de app).
// Vertaalbare teksten: basisveld = Nederlands, vertalingen in `tr: { en: {...}, id: {...} }`.
//
// Datamodel taak (stap in een route), voorbereid op import uit MARAD (nog niet gebouwd):
// {
//   id, locationId, title, instruction, fields: [{ id, label, type: number|text|check|choice, unit, min, max, options, required, tr }],
//   tr: { en: { title, instruction }, id: { title, instruction } },
//   // optioneel, voor geïmporteerde onderhoudstaken:
//   source: 'manual' | 'marad', externalId, equipment, dueDate (ISO), interval: { days, hours, runHours },
//   lastDone (ISO), lastRunHours, priority, meta: {}
// }
// Onbekende velden blijven bij bewerken, dupliceren, delen en importeren behouden.
export function seedData() {
  const D = (id, name, en, idn) => ({ id, name, tr: { en: { name: en }, id: { name: idn } } });
  // Gebieden (in de app "dekken/gebieden"), van achter naar voor.
  const decks = [
    D('opb', 'Opbouw achter', 'Aft superstructure', 'Bangunan atas belakang'),
    D('mk', 'Machinekamer', 'Engine room', 'Kamar mesin'),
    D('dek', 'Open dek', 'Open deck', 'Geladak terbuka'),
    D('ruim', 'Ruim', 'Hold', 'Palka'),
    D('voor', 'Voorschip', 'Forward section', 'Haluan'),
  ];
  // x = lengte (0 = hek, 100 = boeg), z = hoogte (0 = kiel, 100 = top brug), w = breedte (-1 = bakboord, +1 = stuurboord)
  const L = (id, deck, name, en, idn, x, z, w = 0) => ({ id, deck, name, x, z, w, note: '', tr: { en: { name: en }, id: { name: idn } } });
  const locations = [
    L('l-brug', 'opb', 'Brug', 'Bridge', 'Anjungan', 11, 83, 0),
    L('l-galley', 'opb', 'Galley', 'Galley', 'Dapur (galley)', 8, 55, 0.5),
    L('l-toilet', 'opb', 'Toilet store', 'Toilet store', 'Gudang perlengkapan toilet', 15, 48, -0.35),
    L('l-mk-hm', 'mk', 'Machinekamer – hoofdmotor', 'Engine room – main engine', 'Kamar mesin – mesin induk', 6, 14, 0),
    L('l-mk-gen', 'mk', 'Machinekamer – generatoren', 'Engine room – generators', 'Kamar mesin – generator', 12, 22, 0.35),
    L('l-mk-bal', 'mk', 'Machinekamer – ballastsysteem', 'Engine room – ballast system', 'Kamar mesin – sistem ballast', 18, 10, -0.6),
    L('l-poop', 'dek', 'Poopdek', 'Poop deck', 'Geladak kimbul', 3, 47, -0.3),
    L('l-achter', 'dek', 'Achterdek', 'Aft deck', 'Geladak buritan', 22, 38, 0),
    L('l-gw-sb', 'dek', 'Gangway stuurboord', 'Gangway starboard', 'Gangway lambung kanan', 28, 38, 0.85),
    L('l-gw-bb', 'dek', 'Gangway bakboord', 'Gangway port', 'Gangway lambung kiri', 33, 38, -0.85),
    L('l-ruim', 'ruim', 'Ruim', 'Hold', 'Palka', 55, 22, 0),
    L('l-voor', 'dek', 'Voordek', 'Foredeck', 'Geladak haluan', 87, 38, 0),
    L('l-fc', 'dek', 'Forecastle', 'Forecastle', 'Akil (forecastle)', 95, 47, 0),
    L('l-co2', 'voor', 'CO2-ruimte', 'CO2 room', 'Ruang CO2', 90, 24, 0.4),
    L('l-emgen', 'voor', 'Emergency generator', 'Emergency generator', 'Generator darurat', 96, 31, -0.3),
    L('l-boeg', 'voor', 'Boegschroefruimte', 'Bow thruster room', 'Ruang bow thruster', 92, 9, 0.3),
  ];
  // F(label, [en, id], type, extra) ; opties: extra.options = nl, extra.opt = { en: [...], id: [...] }
  const F = (label, [en, idn], type, extra = {}) => {
    const { opt, ...rest } = extra;
    return { id: rid(), label, type, ...rest, tr: { en: { label: en, ...(opt ? { options: opt.en } : {}) }, id: { label: idn, ...(opt ? { options: opt.id } : {}) } } };
  };
  const S = (locationId, [title, en, idn], [instr, ien, iid], fields = []) => ({ id: rid(), source: 'manual', locationId, title, instruction: instr, fields, tr: { en: { title: en, instruction: ien }, id: { title: idn, instruction: iid } } });
  const OK = ['Oliepeil in orde', ['Oil level OK', 'Level oli baik']];
  const daily = {
    id: 'r-dagronde',
    name: 'Dagelijkse technische ronde',
    description: 'Ochtendronde machinekamer, emergency generator, ruim, boegschroef en brug.',
    tr: {
      en: { name: 'Daily technical round', description: 'Morning round: engine room, emergency generator, hold, bow thruster and bridge.' },
      id: { name: 'Ronde teknis harian', description: 'Ronde pagi: kamar mesin, generator darurat, palka, bow thruster dan anjungan.' },
    },
    assignee: '', createdAt: Date.now(), updatedAt: Date.now(),
    steps: [
      S('l-mk-hm', ['Hoofdmotor SB controleren', 'Check main engine SB', 'Periksa mesin induk kanan'],
        ['Controleer oliepeil met peilstok en lees de bedrijfsuren af.', 'Check the oil level with the dipstick and read the running hours.', 'Periksa level oli dengan tongkat ukur dan baca jam kerja mesin.'], [
        F(...OK, 'check', { required: true }),
        F('Bedrijfsuren', ['Running hours', 'Jam kerja'], 'number', { unit: 'h' }),
      ]),
      S('l-mk-hm', ['Koelwater hoofdmotor BB', 'Cooling water main engine port', 'Air pendingin mesin induk kiri'],
        ['Lees de koelwatertemperatuur af op het lokale paneel.', 'Read the cooling water temperature on the local panel.', 'Baca suhu air pendingin pada panel lokal.'], [
        F('Koelwatertemperatuur', ['Cooling water temperature', 'Suhu air pendingin'], 'number', { unit: '°C', min: 70, max: 90, required: true }),
      ]),
      S('l-mk-gen', ['Generator 1 in bedrijf', 'Generator 1 running', 'Generator 1 beroperasi'],
        ['Controleer spanning, frequentie en kijk naar lekkage.', 'Check voltage and frequency and look for leaks.', 'Periksa tegangan dan frekuensi serta cek kebocoran.'], [
        F('Spanning', ['Voltage', 'Tegangan'], 'number', { unit: 'V', min: 390, max: 410 }),
        F('Frequentie', ['Frequency', 'Frekuensi'], 'number', { unit: 'Hz', min: 49.5, max: 50.5 }),
        F('Lekkage gezien', ['Leak found', 'Ada kebocoran'], 'check'),
      ]),
      S('l-mk-bal', ['Ballastsysteem', 'Ballast system', 'Sistem ballast'],
        ['Controleer ballastpomp, kleppenstand en lekkage.', 'Check the ballast pump, valve positions and leaks.', 'Periksa pompa ballast, posisi katup dan kebocoran.'], [
        F(...OK, 'check', { required: true }),
        F('Opmerking', ['Remark', 'Catatan'], 'text'),
      ]),
      S('l-emgen', ['Emergency generator', 'Emergency generator', 'Generator darurat'],
        ['Controleer brandstofpeil, startaccu en of hij in AUTO staat.', 'Check the fuel level, starter battery and that it is set to AUTO.', 'Periksa level bahan bakar, aki starter dan pastikan pada posisi AUTO.'], [
        F('Stand AUTO', ['Set to AUTO', 'Posisi AUTO'], 'check', { required: true }),
        F('Accuspanning', ['Battery voltage', 'Tegangan aki'], 'number', { unit: 'V', min: 24, max: 28.5 }),
      ]),
      S('l-ruim', ['Ruim controleren', 'Inspect the hold', 'Periksa palka'],
        ['Kijk naar water, lekkage en vastzetting van de lading/voorraad.', 'Look for water, leaks and check the lashing of cargo/stores.', 'Periksa adanya air, kebocoran, dan pengikatan muatan/perbekalan.'], [
        F('Droog', ['Dry', 'Kering'], 'check', { required: true }),
        F('Opmerking', ['Remark', 'Catatan'], 'text'),
      ]),
      S('l-boeg', ['Boegschroefruimte', 'Bow thruster room', 'Ruang bow thruster'],
        ['Controleer of de bilge droog is en voel aan de lagerhuizen.', 'Check that the bilge is dry and feel the bearing housings.', 'Pastikan got (bilga) kering dan raba rumah bantalan.'], [
        F('Bilge droog', ['Bilge dry', 'Got kering'], 'check', { required: true }),
        F('Toestand', ['Condition', 'Kondisi'], 'choice', { options: ['Goed', 'Aandacht nodig', 'Slecht'], opt: { en: ['Good', 'Needs attention', 'Bad'], id: ['Baik', 'Perlu perhatian', 'Buruk'] } }),
      ]),
      S('l-brug', ['Logboek bijwerken', 'Update the log book', 'Isi buku harian (log book)'],
        ['Noteer bijzonderheden van de ronde in het machinelogboek.', 'Record anything notable from the round in the engine log book.', 'Catat hal-hal khusus dari ronde di buku harian mesin.'], [
        F('Bijzonderheden', ['Notable items', 'Hal khusus'], 'text'),
      ]),
    ],
  };
  const okF = () => F('In orde', ['OK', 'Baik'], 'check');
  const fire = {
    id: 'r-brand',
    name: 'Weekcontrole brandveiligheid',
    description: 'CO2, gangways, galley en forecastle.',
    tr: {
      en: { name: 'Weekly fire safety check', description: 'CO2, gangways, galley and forecastle.' },
      id: { name: 'Pemeriksaan mingguan keselamatan kebakaran', description: 'CO2, gangway, dapur dan akil.' },
    },
    assignee: 'Hessel', createdAt: Date.now(), updatedAt: Date.now(),
    steps: [
      S('l-co2', ['CO2-installatie', 'CO2 installation', 'Instalasi CO2'],
        ['Controleer flessendruk/weegwaarde en of de ruimte afgesloten is.', 'Check cylinder pressure/weight and that the room is locked.', 'Periksa tekanan/berat tabung dan pastikan ruangan terkunci.'], [
        F('Flessen in orde', ['Cylinders OK', 'Tabung baik'], 'check', { required: true }),
        F('Druk', ['Pressure', 'Tekanan'], 'number', { unit: 'bar', min: 45, max: 60 }),
      ]),
      S('l-gw-sb', ['Gangway stuurboord', 'Gangway starboard', 'Gangway lambung kanan'],
        ['Controleer reddingsboei, verlichting en veiligheidsnet.', 'Check the lifebuoy, lighting and safety net.', 'Periksa pelampung, penerangan dan jaring pengaman.'], [okF()]),
      S('l-galley', ['Blusdeken & blusser galley', 'Fire blanket & extinguisher galley', 'Selimut api & APAR dapur'],
        ['Controleer aanwezigheid en keuringsdatum.', 'Check presence and inspection date.', 'Periksa keberadaan dan tanggal inspeksi.'], [
        F('Aanwezig en gekeurd', ['Present and inspected', 'Ada dan sudah diinspeksi'], 'check', { required: true }),
      ]),
      S('l-gw-bb', ['Gangway bakboord', 'Gangway port', 'Gangway lambung kiri'],
        ['Controleer reddingsboei, verlichting en veiligheidsnet.', 'Check the lifebuoy, lighting and safety net.', 'Periksa pelampung, penerangan dan jaring pengaman.'], [okF()]),
      S('l-fc', ['Forecastle', 'Forecastle', 'Akil (forecastle)'],
        ['Controleer brandslang, ankerlier-bediening en noodverlichting.', 'Check the fire hose, windlass controls and emergency lighting.', 'Periksa selang pemadam, kontrol mesin jangkar (windlass) dan lampu darurat.'], [okF()]),
    ],
  };
  const library = [
    S('l-mk-hm', ['Bilge machinekamer controleren', 'Check engine room bilge', 'Periksa got kamar mesin'], ['Kijk of de bilge droog is.', 'Check that the bilge is dry.', 'Pastikan got kering.'], [F('Bilge droog', ['Bilge dry', 'Got kering'], 'check')]),
    S('l-mk-gen', ['Dagtank peilen', 'Sound the day tank', 'Ukur tangki harian'], ['Lees de inhoud van de dagtank af.', 'Read the contents of the day tank.', 'Baca isi tangki harian.'], [F('Inhoud', ['Contents', 'Isi'], 'number', { unit: 'L', min: 500 })]),
    S('l-toilet', ['Voorraad toilet store', 'Toilet store stock', 'Stok gudang toilet'], ['Controleer voorraad schoonmaak- en sanitairartikelen.', 'Check stock of cleaning and sanitary supplies.', 'Periksa stok alat kebersihan dan perlengkapan sanitasi.'], [F('Voorraad', ['Stock', 'Stok'], 'choice', { options: ['Voldoende', 'Bijna op', 'Op'], opt: { en: ['Sufficient', 'Running low', 'Out'], id: ['Cukup', 'Hampir habis', 'Habis'] } })]),
  ];
  return {
    version: 2,
    shipName: 'Amadeus Aquamarijn',
    decks,
    locations,
    routes: [daily, fire],
    library,
    contacts: [{ id: 'c-hessel', name: 'Hessel', phone: '', email: '' }],
    runs: [],
    activeRun: null,
    plans: [],
    settings: { theme: 'auto', vibrate: true, speak: false, wakeLock: true, fullscreen: true, bigText: false, resumeOnStart: true, userName: '', ntfyServer: 'https://ntfy.sh', ntfyTopic: '', ntfyTopicAuto: true },
  };
}
export function rid() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
