import { readFile } from 'node:fs/promises';

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';

import { formatNameForCertificate, validateRecipientName } from './certificates.js';
import { httpError } from './http-error.js';

// Plantillas de constancia. Las cajas se expresan como FRACCIONES de la página para no depender
// del tamaño real del PDF. Valores calibrados con render real (ver samples/ en .agents/tasks).
export const CERTIFICATE_TEMPLATES = Object.freeze({
  'mujer-legaltech': Object.freeze({
    key: 'mujer-legaltech',
    codePrefix: 'MLT',
    pdfUrl: new URL('../../assets/certificates/mujer-legaltech.pdf', import.meta.url),
    fontUrl: new URL('../../assets/fonts/Poppins-SemiBold.ttf', import.meta.url),
    filename: 'Constancia-Mujer-LegalTech.pdf',
    title: 'Constancia Mujer LegalTech',
    // Metadatos de la constancia verificable en línea (no afectan al PDF).
    issuer: 'Mujer LegalTech en México',
    durationHours: 20,
    modality: '100% en línea',
    badgeUrl: new URL('../../assets/badges/mujer-legaltech.png', import.meta.url),
    subject: 'Constancia de participación en el curso Mujer LegalTech',
    // La plantilla trae un campo de formulario de texto (recuadro del nombre) cuya apariencia tapa el
    // contenido de la página. Se aplana VACÍO para conservar el recuadro y el nombre se dibuja encima.
    nameField: 'Nombre_del_alumno',
    nameBox: Object.freeze({
      widthFraction: 0.58, // ancho máximo del nombre (fracción del ancho de página; el recuadro mide 62 %)
      centerTop: 0.452, // centro vertical del recuadro, fracción del alto medida desde arriba
      capRatio: 0.35, // media altura de mayúsculas de Poppins (fracción del tamaño) para centrar sobre centerTop
      fontSize: 0.04, // tamaño inicial, fracción del alto de página
      minFontSize: 0.018, // tamaño mínimo, fracción del alto
    }),
    color: Object.freeze({ r: 26, g: 26, b: 26 }), // #1a1a1a
  }),
});

const fileCache = new Map();

async function readCached(url) {
  const key = url.href;
  if (!fileCache.has(key)) {
    fileCache.set(
      key,
      readFile(url).catch((error) => {
        fileCache.delete(key);
        throw error;
      }),
    );
  }
  return fileCache.get(key);
}

export function getCertificateTemplate(template) {
  const found = typeof template === 'string' ? CERTIFICATE_TEMPLATES[template] : template;
  if (!found || typeof found !== 'object' || !found.pdfUrl) throw httpError(404, 'Este curso no emite constancia.');
  return found;
}

async function loadFont(pdfDoc, definition) {
  pdfDoc.registerFontkit(fontkit);
  return pdfDoc.embedFont(await readCached(definition.fontUrl), { subset: true });
}

// Calcula el tamaño de letra que cabe en la caja; lanza 400 si hay glifos sin soporte o no cabe.
function fitName(font, text, definition, pageWidth, pageHeight) {
  const supported = new Set(font.getCharacterSet());
  const unsupported = [...text].find((char) => !supported.has(char.codePointAt(0)));
  if (unsupported) throw httpError(400, `El nombre contiene un carácter no admitido en la constancia: «${unsupported}».`);
  const { widthFraction, fontSize, minFontSize } = definition.nameBox;
  const maxWidth = widthFraction * pageWidth;
  const initial = fontSize * pageHeight;
  const minimum = minFontSize * pageHeight;
  let size = initial;
  const initialWidth = font.widthOfTextAtSize(text, size);
  if (initialWidth > maxWidth) size = Math.floor((initial * maxWidth * 10) / initialWidth) / 10;
  while (size >= minimum && font.widthOfTextAtSize(text, size) > maxWidth) size = Math.round((size - 0.1) * 10) / 10;
  if (size < minimum) throw httpError(400, 'El nombre es demasiado largo para caber en la constancia.');
  return size;
}

// Plantilla con el campo del nombre aplanado y la primera página copiada a un documento nuevo
// (re-guardar el original deja un xref con generaciones inconsistentes que pdf.js tiene que reparar).
async function loadBlankTemplate(definition) {
  const source = await PDFDocument.load(await readCached(definition.pdfUrl));
  const form = source.getForm();
  form.getTextField(definition.nameField).setText('');
  form.flatten();
  const pdfDoc = await PDFDocument.create();
  const [copied] = await pdfDoc.copyPages(source, [0]);
  pdfDoc.addPage(copied);
  return pdfDoc;
}

async function prepare(template, recipientName) {
  const definition = getCertificateTemplate(template);
  const text = formatNameForCertificate(validateRecipientName(recipientName));
  const pdfDoc = await loadBlankTemplate(definition);
  const font = await loadFont(pdfDoc, definition);
  const page = pdfDoc.getPage(0);
  const { width, height } = page.getSize();
  const size = fitName(font, text, definition, width, height);
  return { definition, text, pdfDoc, font, page, width, height, size };
}

// Verifica (sin generar el archivo final) que el nombre cabe y que la fuente tiene todos los glifos.
export async function assertNameRenderable({ template, recipientName }) {
  await prepare(template, recipientName);
}

export async function generateCertificatePdf({ template, recipientName, certificateCode = null, issuedAt = new Date() }) {
  const { definition, text, pdfDoc, font, page, width, height, size } = await prepare(template, recipientName);
  const { color, nameBox } = definition;
  page.drawText(text, {
    x: width / 2 - font.widthOfTextAtSize(text, size) / 2,
    y: height * (1 - nameBox.centerTop) - nameBox.capRatio * size,
    size,
    font,
    color: rgb(color.r / 255, color.g / 255, color.b / 255),
  });
  const created = issuedAt instanceof Date ? issuedAt : new Date(issuedAt);
  pdfDoc.setTitle(definition.title);
  pdfDoc.setAuthor('Streamly Academia');
  pdfDoc.setSubject(definition.subject);
  pdfDoc.setKeywords(certificateCode ? ['constancia', definition.key, certificateCode] : ['constancia', definition.key]);
  pdfDoc.setProducer('Streamly Academia');
  pdfDoc.setCreator('Streamly Academia');
  pdfDoc.setCreationDate(created);
  pdfDoc.setModificationDate(created);
  // Sin object streams: máxima compatibilidad con visores (pdf.js, navegadores, móviles).
  return pdfDoc.save({ useObjectStreams: false });
}
