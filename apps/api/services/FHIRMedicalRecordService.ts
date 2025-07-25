/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import mongoose from 'mongoose';
import medicalRecords from '../models/MedicalRecords';
import helpers from '../utils/helpers';
import { FHIRMedicalDocumentReference, InternalMedicalRecord, MedicalDoc, MedicalRecord } from '@yosemite-crew/types';


export default class FHIRMedicalRecordService {
  static convertFHIRToMedicalRecord(fhirData: unknown): InternalMedicalRecord {
    if (!fhirData || typeof fhirData !== 'object') {
      throw new Error("Invalid FHIR data format.");
    }

     
    const data = fhirData as FHIRMedicalDocumentReference;

     console.log("hello",data)
    if (data.resourceType !== 'DocumentReference') {
      throw new Error("Unsupported FHIR resourceType. Expected 'DocumentReference'.");
    }

     
    const documentType = data.type?.text;
    const title = data.description;
    const issueDate = data.date;
    const expiryDate = data.context?.period?.end;
    const patientId = data.subject?.reference?.split('/')?.[1];

    if (!documentType) {
      throw new Error("Missing required FHIR field: type.text");
    }

    if (!title) {
      throw new Error("Missing required FHIR field: description");
    }

    if (!patientId) {
      throw new Error("Missing or invalid FHIR field: subject.reference");
    }

    return {
      documentType,
      title,
      issueDate,
      expiryDate,
      patientId,
    };
  }

  static convertMedicalRecordToFHIR(record: MedicalRecord): any {
  if (!record) throw new Error("Invalid medical record.");

  const id = record._id ? record._id.toString() : record.id;

  return {
    resourceType: "DocumentReference",
    id,
    status: "current",

    type: {
      text: record.documentType,
    },

    description: record.title,
    date: record.issueDate,

    subject: {
      identifier: {
        value: record.userId,
      },
      reference: record.petId ? `Patient/${record.petId}` : undefined,
    },

    context: {
      period: {
        end: record.hasExpiryDate ? record.expiryDate : "",
      },
    },

    content: Array.isArray(record.medicalDocs) && record.medicalDocs.length > 0
      ? record.medicalDocs.map((doc: MedicalDoc) => ({
          attachment: {
            url: doc.url ?? '',
            title: doc.originalname ?? '',
            contentType: doc.mimetype ?? 'application/pdf',
          },
        }))
      : [],

    extension: [
      {
        url: "http://example.org/fhir/StructureDefinition/has-expiry-date",
        valueBoolean: record.hasExpiryDate,
      },
    ],
  };
}

  static async deleteMedicalRecord(id: string): Promise<object | null> {
    const objectId = new mongoose.Types.ObjectId(id);
    const data = await medicalRecords.find({ _id: objectId });

    if (data.length === 0) {
      return null;
    }

    const docs = data[0].medicalDocs;
    if (Array.isArray(docs)) {
      for (const doc of docs) {
        if (doc.url) {
          await helpers.deleteFiles(doc.url);
        }
      }
    }

    return await medicalRecords.deleteOne({ _id: objectId });
  }
}
