/**
 * QTI 2.1 export.
 *
 * QTI is the interoperability standard for assessment content. Exporting it is
 * what lets a generated test land in Moodle, Canvas, TAO or any other conformant
 * platform — and, once delivered there, lets results come back through the
 * response-ingestion endpoints.
 *
 * The output is an IMS Content Package: a zip containing one `assessmentItem`
 * per question, an `assessmentTest` describing the sections and order, and an
 * `imsmanifest.xml` tying them together.
 *
 * Question types map onto QTI interactions as follows:
 *
 *   MCQ, True/False   choiceInteraction, maxChoices 1
 *   Multiple Select   choiceInteraction, maxChoices 0 (unlimited)
 *   Fill in the Blank textEntryInteraction
 *   everything else   extendedTextInteraction, graded externally
 */

import JSZip from 'jszip';
import { getTest } from './testService.js';

/** XML text escaping. Applied to every value that comes from the bank. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** QTI identifiers must be NCNames: no spaces, not starting with a digit. */
function identifier(value, prefix = 'ID') {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `${prefix}_${cleaned}`;
}

const CHOICE_TYPES = new Set(['MCQ', 'Multiple Select', 'True/False']);

/** One assessmentItem document. */
function buildItem(entry) {
  const question = entry.question;
  const itemId = identifier(entry.qid, 'item');

  if (CHOICE_TYPES.has(question.question_type) && question.options?.length) {
    const multiple = question.question_type === 'Multiple Select';
    const correct = question.options.filter((o) => o.is_correct);

    const choices = question.options
      .map((option, index) => `        <simpleChoice identifier="choice_${index + 1}">${esc(option.option_text)}</simpleChoice>`)
      .join('\n');

    const correctValues = correct
      .map((option) => `      <value>choice_${question.options.indexOf(option) + 1}</value>`)
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<assessmentItem xmlns="http://www.imsglobal.org/xsd/imsqti_v2p1"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.imsglobal.org/xsd/imsqti_v2p1 http://www.imsglobal.org/xsd/qti/qtiv2p1/imsqti_v2p1.xsd"
    identifier="${esc(itemId)}" title="${esc(entry.qid)}" adaptive="false" timeDependent="false">
  <responseDeclaration identifier="RESPONSE" cardinality="${multiple ? 'multiple' : 'single'}" baseType="identifier">
    <correctResponse>
${correctValues}
    </correctResponse>
  </responseDeclaration>
  <outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float">
    <defaultValue><value>0</value></defaultValue>
  </outcomeDeclaration>
  <outcomeDeclaration identifier="MAXSCORE" cardinality="single" baseType="float">
    <defaultValue><value>${Number(entry.marks) || 1}</value></defaultValue>
  </outcomeDeclaration>
  <itemBody>
    <p>${esc(question.question_text)}</p>
    <choiceInteraction responseIdentifier="RESPONSE" shuffle="false" maxChoices="${multiple ? 0 : 1}">
${choices}
    </choiceInteraction>
  </itemBody>
  <responseProcessing template="http://www.imsglobal.org/question/qti_v2p1/rptemplates/match_correct"/>
</assessmentItem>
`;
  }

  // Free-form types. Fill in the blank gets a short text entry; everything
  // else gets an extended response, graded outside the platform.
  const shortAnswer = question.question_type === 'Fill in the Blank';
  const interaction = shortAnswer
    ? `    <p>${esc(question.question_text)}</p>
    <textEntryInteraction responseIdentifier="RESPONSE" expectedLength="40"/>`
    : `    <p>${esc(question.question_text)}</p>
    <extendedTextInteraction responseIdentifier="RESPONSE" expectedLength="800"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<assessmentItem xmlns="http://www.imsglobal.org/xsd/imsqti_v2p1"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.imsglobal.org/xsd/imsqti_v2p1 http://www.imsglobal.org/xsd/qti/qtiv2p1/imsqti_v2p1.xsd"
    identifier="${esc(itemId)}" title="${esc(entry.qid)}" adaptive="false" timeDependent="false">
  <responseDeclaration identifier="RESPONSE" cardinality="single" baseType="string"/>
  <outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float">
    <defaultValue><value>0</value></defaultValue>
  </outcomeDeclaration>
  <outcomeDeclaration identifier="MAXSCORE" cardinality="single" baseType="float">
    <defaultValue><value>${Number(entry.marks) || 1}</value></defaultValue>
  </outcomeDeclaration>
  <itemBody>
${interaction}
  </itemBody>
</assessmentItem>
`;
}

/** The assessmentTest document: sections, order and timing. */
function buildTest(test) {
  const sections = test.sections
    .map((section, index) => {
      const refs = section.questions
        .map((entry) => {
          const itemId = identifier(entry.qid, 'item');
          return `        <assessmentItemRef identifier="ref_${esc(itemId)}" href="items/${esc(itemId)}.xml" required="true"/>`;
        })
        .join('\n');

      const timeLimit = section.time_limit_minutes
        ? `      <timeLimits maxTime="${section.time_limit_minutes * 60}"/>\n`
        : '';

      return `    <assessmentSection identifier="section_${index + 1}" title="${esc(section.section_name)}" visible="true">
${timeLimit}      <ordering shuffle="${test.randomize_questions ? 'true' : 'false'}"/>
${refs}
    </assessmentSection>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<assessmentTest xmlns="http://www.imsglobal.org/xsd/imsqti_v2p1"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.imsglobal.org/xsd/imsqti_v2p1 http://www.imsglobal.org/xsd/qti/qtiv2p1/imsqti_v2p1.xsd"
    identifier="${esc(identifier(test.test_id, 'test'))}" title="${esc(test.test_name)}">
  <outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float">
    <defaultValue><value>0</value></defaultValue>
  </outcomeDeclaration>
  <testPart identifier="part_1" navigationMode="nonlinear" submissionMode="individual">
    <itemSessionControl maxAttempts="1"/>
    <timeLimits maxTime="${(test.duration_minutes || 60) * 60}"/>
${sections}
  </testPart>
  <outcomeProcessing>
    <setOutcomeValue identifier="SCORE">
      <sum><testVariables variableIdentifier="SCORE"/></sum>
    </setOutcomeValue>
  </outcomeProcessing>
</assessmentTest>
`;
}

/** The IMS content package manifest. */
function buildManifest(test, itemIds) {
  const testId = identifier(test.test_id, 'test');

  const itemResources = itemIds
    .map(
      (itemId) => `    <resource identifier="res_${esc(itemId)}" type="imsqti_item_xmlv2p1" href="items/${esc(itemId)}.xml">
      <file href="items/${esc(itemId)}.xml"/>
    </resource>`,
    )
    .join('\n');

  const dependencies = itemIds
    .map((itemId) => `      <dependency identifierref="res_${esc(itemId)}"/>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
    xmlns:imsmd="http://ltsc.ieee.org/xsd/LOM"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    identifier="manifest_${esc(testId)}">
  <metadata>
    <schema>IMS Content</schema>
    <schemaversion>1.1.3</schemaversion>
    <imsmd:lom>
      <imsmd:general>
        <imsmd:title><imsmd:string>${esc(test.test_name)}</imsmd:string></imsmd:title>
        <imsmd:description><imsmd:string>${esc(test.description || '')}</imsmd:string></imsmd:description>
      </imsmd:general>
    </imsmd:lom>
  </metadata>
  <organizations/>
  <resources>
    <resource identifier="res_${esc(testId)}" type="imsqti_test_xmlv2p1" href="${esc(testId)}.xml">
      <file href="${esc(testId)}.xml"/>
${dependencies}
    </resource>
${itemResources}
  </resources>
</manifest>
`;
}

/**
 * Builds the QTI 2.1 content package for a test.
 * @returns {Promise<Buffer>} the zip
 */
export async function toQtiPackage(testDbId) {
  const test = getTest(testDbId, { withAnswers: true });
  const zip = new JSZip();
  const items = zip.folder('items');
  const itemIds = [];

  for (const section of test.sections) {
    for (const entry of section.questions) {
      if (!entry.question || entry.question.missing) continue;
      const itemId = identifier(entry.qid, 'item');
      itemIds.push(itemId);
      items.file(`${itemId}.xml`, buildItem(entry));
    }
  }

  zip.file(`${identifier(test.test_id, 'test')}.xml`, buildTest(test));
  zip.file('imsmanifest.xml', buildManifest(test, itemIds));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export const qtiInternals = { esc, identifier, buildItem, buildTest, buildManifest };
