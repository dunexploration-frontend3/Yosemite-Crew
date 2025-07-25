import mongoose from "mongoose";
const AddDoctors = require("../models/AddDoctor");
const baseUrl = process.env.BASE_URL;

class DoctorService {
  static async getDoctorsByBusinessAndDepartment(departmentId :string, limit :number, offset :number ){
    if (!mongoose.Types.ObjectId.isValid(departmentId)) {
      return { status: 0, message: 'Invalid department ID' };
    }
  
    const specializationId = departmentId;
  
    const doctors = await AddDoctors.aggregate([
      {
        $match: {
          "professionalBackground.specialization": specializationId
        }
      },
      {
        $addFields: {
          departmentObjId: { $toObjectId: specializationId }
        }
      },
      {
        $lookup: {
          from: "departments",
          localField: "departmentObjId",
          foreignField: "_id",
          as: "departmentInfo"
        }
      },
      {
        $unwind: {
          path: "$departmentInfo",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $lookup: {
          from: "feedbacks",
          localField: "userId",
          foreignField: "toId",
          as: "ratings"
        }
      },
      {
        $set: {
          rating: {
            $cond: [
              { $gt: [{ $size: "$ratings" }, 0] },
              { $round: [{ $avg: "$ratings.rating" }, 1] },
              0
            ]
          }
        }
      },
      {
        $project: {
          ratings: 0
        }
      },
      { $skip: offset || 0 },
      { $limit: limit || 10 }
    ]);
  
    const fhirDoctors = doctors.map((doc :any) => this.toFhirPractitioner(doc));
  
    return {
      resourceType: "Bundle",
      type: "searchset",
      total: fhirDoctors.length,
      entry: fhirDoctors.map((practitioner :any) => ({ resource: practitioner }))
    };
  }

  static toFhirPractitioner(doc :any)  {
    const firstName = doc.personalInfo?.firstName || "";
    const lastName = doc.personalInfo?.lastName || "";
    const fullName = `${firstName} ${lastName}`.trim();
    const departmentName = doc.departmentInfo?.departmentName || "Unknown";
    const consultationFee = doc.consultFee || 0;
    const experience = doc.professionalBackground?.yearsOfExperience || 0;
    const docImage = doc.personalInfo?.image || "";
    const qualifications = Array.isArray(doc.professionalBackground?.qualification)
      ? doc.professionalBackground.qualification
      : doc.professionalBackground?.qualification
        ? [doc.professionalBackground.qualification]
        : [];
  
    return {
      resourceType: "Practitioner",
      id: doc.userId,
      name: [
        {
          text: fullName
        }
      ],
      department: [
        {
          code: {
            text: departmentName
          }
        }
      ],
      qualification: qualifications.map((q :string) => ({
        code: {
          text: q
        }
      })),
      extension: [
        {
          url: `${baseUrl}/fhir/StructureDefinition/average-rating`,
          valueDecimal: doc.rating || 0,
          title: "averageRating",
        },
        {
          url: `${baseUrl}/fhir/StructureDefinition/consultation-fee`,
          valueDecimal: consultationFee,
          title: "consultationFee",
        },
        {
          url: `${baseUrl}/fhir/StructureDefinition/experience-years`,
          valueInteger: experience,
          title: "experienceYears",
        },
        {
          url: `${baseUrl}/fhir/StructureDefinition/doctor-image`,
          valueString: docImage,
          title: "doctorImage",
        }
      ]
    };
  }
  

  static async getDoctorsWithAppointments(businessId :string) {
    const today = new Date().toISOString().split("T")[0];
    const currentTime = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

    const doctors = await AddDoctors.aggregate([
      { $match: { bussinessId: businessId } },
      {
        $lookup: {
          from: "webappointments",
          let: { veterinarian: "$userId", todayDate: today, nowTime: currentTime },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$veterinarian", "$$veterinarian"] },
                    {
                      $or: [
                        {
                          $and: [
                            { $eq: ["$appointmentDate", "$$todayDate"] },
                            { $gt: ["$appointmentTime24", "$$nowTime"] }
                          ]
                        },
                        { $gt: ["$appointmentDate", "$$todayDate"] }
                      ]
                    }
                  ]
                }
              }
            },
            {
              $project: {
                _id: 1,
                appointmentDate: 1,
                appointmentTime24: 1,
                ownerName: 1,
                petName: 1,
                purposeOfVisit: 1
              }
            }
          ],
          as: "futureAppointments"
        }
      },
      {
        $addFields: {
          hasUpcomingAppointment: {
            $gt: [{ $size: "$futureAppointments" }, 0]
          }
        }
      },
      {
        $project: {
          _id: 1,
          userId: 1,
          "personalInfo.firstName": 1,
          "personalInfo.lastName": 1,
          "personalInfo.image": 1,
          futureAppointments: 1,
          hasUpcomingAppointment: 1
        }
      }
    ]);
    
    return doctors.map((doc :any) => this.mapToFHIR(doc));
  }

  static mapToFHIR(doc :any) {
    const practitioner = {
      resourceType: "Practitioner",
      id: doc.userId || doc._id.toString(),
      name: [
        {
          use: "official",
          family: doc.personalInfo?.lastName || "",
          given: [doc.personalInfo?.firstName || ""]
        }
      ],
      photo: doc.personalInfo?.image ? [{ url: doc.personalInfo.image }] : []
    };
 
    const appointments = doc.futureAppointments.map((appt :any) => ({
      resourceType: "Appointment",
      id: appt._id.toString(),
      status: "booked",
      description: appt.purposeOfVisit || "Consultation",
      start: `${appt.appointmentDate}T${appt.appointmentTime24}:00`,
      hasUpcomingAppointment: true, // ✅ This is the added flag
      participant: [
        {
          actor: {
            reference: `Practitioner/${doc._id}`,
            display: `${doc.personalInfo?.firstName} ${doc.personalInfo?.lastName}`
          },
          status: "accepted"
        },
        {
          actor: {
            display: `${appt.ownerName} (${appt.petName})`
          },
          status: "accepted"
        }
      ]
    }));
  
    return {
      practitioner,
      appointments
    };
  }

}

module.exports = DoctorService;
