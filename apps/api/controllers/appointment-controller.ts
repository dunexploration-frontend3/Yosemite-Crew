import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { getCognitoUserId } from '../middlewares/authMiddleware';
import appointmentService from '../services/appointment-service'
import {fhirAppointmentFormatter} from '@yosemite-crew/fhir'
import helpers from '../utils/helpers';
import {FHIRTransformer} from '@yosemite-crew/fhir';
import { IFHIRAppointmentData, IParsedAppointmentDetails, IProfileData, WebAppointmentType } from '@yosemite-crew/types';


const appointmentController = {

  bookAppointment: async (req: Request<unknown, unknown, {data:IFHIRAppointmentData}>, res: Response): Promise<void> => {
    try {
      const userId = getCognitoUserId(req as Request);

      // Parse FHIR data if provided
      const data  = req.body.data;
      let appointmentDetails: IParsedAppointmentDetails | null = null;
      if (data) {
        appointmentDetails =  FHIRTransformer.parseAppointment(req.body.data);
      }

      if (!appointmentDetails) {
        res.status(400).json({
          status: 0,
          message: "Invalid or missing appointment details.",
        });
        return;
      }

      const {
        appointmentDate,
        purposeOfVisit,
        hospitalId,
        department,
        doctorId,
        petId,
        slotsId,
        timeslot,
        concernOfVisit,
      } = appointmentDetails;

      // Compute day of the week
      const dayOfWeek = new Date(appointmentDate).toLocaleDateString('en-US', { weekday: 'long' });

      // Check slot availability
      const isBooked = await appointmentService.checkAppointment(doctorId, appointmentDate, timeslot);
      if (isBooked) {
        res.status(200).json({
          status: 0,
          message: "This time slot is already booked for the selected doctor.",
        });
      }

      // Parallelize conversions, file uploads, and data fetching
      const uploadedFilesForHelper: Express.Multer.File[] = Array.isArray(req.files)
        ? req.files
        : req.files
          ? Object.values(req.files).flat()
          : [];
      const [appointmentTime24, documentFiles, { petDetails, petOwner }] = await Promise.all([
        helpers.convertTo24Hour(timeslot),
        uploadedFilesForHelper.length > 0 ? helpers.uploadFiles(uploadedFilesForHelper ) : [],
        appointmentService.getPetAndOwner(petId, userId),
      ]);
    
      if(!petDetails || !petOwner) {
        res.status(400).json({
          status: 0,
          message: "Pet or owner details not found.",
        });
        return;
      }
      const hospitalNameResult = await appointmentService.getHospitalName(hospitalId);
      if (!hospitalNameResult) {
        res.status(400).json({
          status: 0,
          message: "Hospital details not found.",
        });
        return;
      }
      const hospitalName: IProfileData = hospitalNameResult;
      const initials = hospitalName.businessName
        ? hospitalName.businessName.split(' ')
          .map((word) => word[0])
          .join('')
        : 'XX';

      const appointmentToken = await appointmentService.updateToken(hospitalId, appointmentDate);

      const tokenNumber = `${initials}00${appointmentToken.tokenCounts}-${new Date(appointmentDate).toISOString()}`;

      const appointmentData :Partial<WebAppointmentType>= {
        userId,
        hospitalId,
        tokenNumber,
        department,
        veterinarian: doctorId,
        petId,
        ownerName: `${petOwner.firstName} ${petOwner.lastName}`,
        petName: petDetails.petName,
        petAge: petDetails.petAge,
        petType: petDetails.petType,
        gender: petDetails.petGender,
        breed: petDetails.petBreed,
        day: dayOfWeek,
        appointmentDate:String(appointmentDate),
        slotsId,
        appointmentTime: timeslot,
        appointmentTime24,
        purposeOfVisit: purposeOfVisit ?? '',
        concernOfVisit,
        appointmentSource: "App",
        document: documentFiles,
      };



      const fhirAppointment = await appointmentService.bookAppointment(appointmentData);

      if (fhirAppointment) {
        res.status(200).json({ status: 1, message: "Appointment Booked successfully" });
      }

      res.status(200).json({
        status: 0,
        message: "Appointment could not be booked",
      });
      return

    } catch (error: unknown) {
      res.status(500).json({
        status: 0,
        message: "Internal server error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  getAppointment: async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await appointmentService.fetchAppointments(req);
      if (!result) {
         res.status(404).json({ status: 0, message: 'No Appointment found for this user' });
        return;
      }
        res.status(200).json({ status: 1, data: result });
        return
     
      return;
    } catch (error) {
      console.error("Error fetching appointments:", error);
      res.status(500).json({ message: "An error occurred while retrieving appointments" });
    }
  },

  cancelAppointment: async (req: Request<{appointmentId?:string}, unknown , unknown>, res: Response): Promise<void> => {
    try {
      const appointmentIdRaw = req.query.appointmentId;
      if (typeof appointmentIdRaw !== "string" || !/^[a-fA-F0-9-]{36}$/.test(appointmentIdRaw)) {
         res.status(400).json({ status: 0, message: "Invalid Appointment ID format" });
        return;
      }
      // const appointmentId = typeof appointmentIdRaw === 'string' ? appointmentIdRaw : Array.isArray(appointmentIdRaw) ? appointmentIdRaw[0] : undefined;
      // Validate MongoDB ObjectId
     
      const result = await appointmentService.cancelAppointment(appointmentIdRaw);

      if (!result) {
        res.status(200).json({ status: 0, message: "This appointment not found" });
        return
      }

      const fhirData = fhirAppointmentFormatter.toFHIR(result, process.env.BASE_URL as string);

      res.status(200).json({ status: 1, message: "Appointment cancelled successfully", data: fhirData });
      return
      
    } catch (error) {
      console.log(error);
      res.status(200).json({ status: 0, message: "Error while cancelling appointment", error });
      return
    }
  },

  rescheduleAppointment: async (req: Request<{appointmentId:string}, unknown, {timeslot:string,appointmentDate:string,  data :WebAppointmentType}>, res: Response): Promise<void> => {
    try {
    
       const appointmentIdRaw = req.query.appointmentId;
      if (typeof appointmentIdRaw !== "string" || !/^[a-fA-F0-9-]{36}$/.test(appointmentIdRaw)) {
         res.status(400).json({ status: 0, message: "Invalid Appointment ID format" });
        return;
      }
      // const normalData = FHIRConverter.fromFHIRAppointment(req);
      const normalData :Partial<WebAppointmentType> = {
        appointmentDate: req.body.appointmentDate,
        appointmentTime: req.body.timeslot,
        appointmentTime24: helpers.convertTo24Hour(req.body.timeslot),
        document: req.body.data.document,
        purposeOfVisit: req.body.data.purposeOfVisit,
        concernOfVisit: req.body.data.concernOfVisit,
        petId: req.body.data.petId,
        veterinarian: req.body.data.veterinarian,
        department: req.body.data.department,
        slotsId: req.body.data.slotsId,
      };
      const result = await appointmentService.rescheduleAppointment(normalData, appointmentIdRaw);

      res.status(200).json({ status: 1, message: "Appointment rescheduled successfully", data: result });
      return
    } catch (error: unknown) {
      console.log(error)
      res.status(500).json({
        status: 0,
        resourceType: "OperationOutcome",

      });
    }
  }
}

export default appointmentController
