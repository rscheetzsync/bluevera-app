// api/admin-contractors.js
//
// BlueVera Admin Contractor Management API
//
// Supports:
//
// GET  ?action=list
// GET  ?action=detail&id=<contractor uuid>
// GET  ?action=document&documentId=<document uuid>
//
// POST
// {
//   action: "review",
//   contractorId: "<uuid>",
//   credential: "license" | "insurance",
//   decision: "verified" | "rejected" | "pending"
// }
//
// Required environment variables:
//
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
//
// Optional:
//
// SUPABASE_ANON_KEY
//
// Storage bucket:
//
// contractor-files
//
// IMPORTANT:
//
// Contractor credential files remain PRIVATE.
// Admins receive only short-lived signed URLs.
//
// Approving a credential updates:
//
// contractors.license_status
//
// or:
//
// contractors.insurance_status
//
// BlueVera considers the contractor fully credential-verified
// only when BOTH are Verified.
//

const SUPABASE_URL = String(
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  ""
).replace(/\/+$/, "");

const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  "";

const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  SERVICE_ROLE_KEY;

const STORAGE_BUCKET =
  "contractor-files";


/*
  ============================================================
  BASIC HELPERS
  ============================================================
*/

function clean(value) {
  return String(
    value ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();
}


function cleanLower(value) {
  return clean(value)
    .toLowerCase();
}


function send(
  res,
  status,
  body
) {
  return res
    .status(status)
    .json(body);
}


function bearerToken(req) {
  const header =
    clean(
      req.headers?.authorization
    );

  if (
    !header
      .toLowerCase()
      .startsWith("bearer ")
  ) {
    return "";
  }

  return header
    .slice(7)
    .trim();
}


function encodeStoragePath(
  filePath
) {
  return String(filePath || "")
    .split("/")
    .map(segment =>
      encodeURIComponent(segment)
    )
    .join("/");
}


/*
  ============================================================
  SUPABASE REST HELPER
  ============================================================
*/

async function rest(
  path,
  options = {}
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/${path}`,
      {
        ...options,

        headers: {
          Accept:
            "application/json",

          "Content-Type":
            "application/json",

          apikey:
            SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${SERVICE_ROLE_KEY}`,

          ...(options.headers || {})
        }
      }
    );

  const text =
    await response.text();

  let data = null;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {
    data =
      text;
  }

  if (!response.ok) {
    const error =
      new Error(
        data?.message ||
        data?.error ||
        data?.hint ||
        text ||
        `Supabase request failed (${response.status}).`
      );

    error.statusCode =
      response.status;

    error.details =
      data;

    throw error;
  }

  return data;
}


/*
  ============================================================
  REQUIRE AUTHENTICATED SUPABASE USER
  ============================================================
*/

async function requireAuthenticatedUser(
  req
) {
  const token =
    bearerToken(req);

  if (!token) {
    const error =
      new Error(
        "Missing admin authorization token."
      );

    error.statusCode =
      401;

    throw error;
  }

  const response =
    await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        method:
          "GET",

        headers: {
          apikey:
            ANON_KEY,

          Authorization:
            `Bearer ${token}`
        }
      }
    );

  const user =
    await response
      .json()
      .catch(() => null);

  if (
    !response.ok ||
    !user?.id
  ) {
    const error =
      new Error(
        "The admin login session is invalid or expired."
      );

    error.statusCode =
      401;

    throw error;
  }

  return user;
}


/*
  ============================================================
  REQUIRE BLUEVERA ADMIN
  ============================================================

  The authenticated Supabase user must also exist in
  public.admin_users.

  We tolerate several historic BlueVera admin identifier columns.
*/

async function requireAdmin(
  user
) {
  if (!user?.id) {
    const error =
      new Error(
        "Admin user could not be identified."
      );

    error.statusCode =
      401;

    throw error;
  }

  const possibleMatches = [
    {
      column:
        "auth_user_id",

      value:
        user.id
    },

    {
      column:
        "user_id",

      value:
        user.id
    },

    {
      column:
        "id",

      value:
        user.id
    },

    {
      column:
        "email",

      value:
        user.email || ""
    }
  ];


  for (
    const candidate of
    possibleMatches
  ) {
    if (!candidate.value) {
      continue;
    }

    try {
      const rows =
        await rest(
          `admin_users?${candidate.column}=eq.${encodeURIComponent(
            candidate.value
          )}&select=*&limit=1`
        );

      if (
        Array.isArray(rows) &&
        rows.length
      ) {
        const admin =
          rows[0];

        const status =
          cleanLower(
            admin.status ||
            admin.account_status ||
            (
              admin.is_active === false
                ? "disabled"
                : "active"
            )
          );

        if (
          admin.active === false ||
          admin.is_active === false ||
          [
            "disabled",
            "inactive",
            "suspended",
            "denied"
          ].includes(status)
        ) {
          const error =
            new Error(
              "This BlueVera admin account is disabled."
            );

          error.statusCode =
            403;

          throw error;
        }

        return admin;
      }

    } catch (error) {

      /*
        Ignore missing optional identifier columns.

        PostgreSQL undefined-column code:
        42703
      */

      const details =
        JSON.stringify(
          error?.details || {}
        );

      if (
        details.includes("42703") ||
        cleanLower(
          error?.message
        ).includes(
          "does not exist"
        )
      ) {
        continue;
      }

      throw error;
    }
  }


  const error =
    new Error(
      "This authenticated account is not authorized as a BlueVera admin."
    );

  error.statusCode =
    403;

  throw error;
}


/*
  ============================================================
  ADMIN AUTH WRAPPER
  ============================================================
*/

async function requireAdminAccess(
  req
) {
  const user =
    await requireAuthenticatedUser(
      req
    );

  const admin =
    await requireAdmin(
      user
    );

  return {
    user,
    admin
  };
}


/*
  ============================================================
  CONTRACTOR STATUS HELPERS
  ============================================================
*/

function normalizedCredentialStatus(
  value
) {
  const status =
    cleanLower(value);

  if (
    [
      "verified",
      "approved"
    ].includes(status)
  ) {
    return "Verified";
  }

  if (
    [
      "rejected",
      "denied"
    ].includes(status)
  ) {
    return "Rejected";
  }

  if (
    [
      "pending",
      "pending review",
      "uploaded"
    ].includes(status)
  ) {
    return "Pending Review";
  }

  return "Not Uploaded";
}


function getOverallStatus(
  contractor
) {
  const licenseStatus =
    normalizedCredentialStatus(
      contractor?.license_status
    );

  const insuranceStatus =
    normalizedCredentialStatus(
      contractor?.insurance_status
    );


  if (
    licenseStatus === "Verified" &&
    insuranceStatus === "Verified"
  ) {
    return "Verified";
  }


  if (
    licenseStatus === "Rejected" ||
    insuranceStatus === "Rejected"
  ) {
    return "Needs Attention";
  }


  if (
    licenseStatus === "Not Uploaded" ||
    insuranceStatus === "Not Uploaded"
  ) {
    return "Missing Documents";
  }


  return "Pending Review";
}


/*
  ============================================================
  LOAD CONTRACTOR DOCUMENTS
  ============================================================
*/

async function loadDocuments(
  contractorId
) {
  const rows =
    await rest(
      `contractor_documents?contractor_id=eq.${encodeURIComponent(
        contractorId
      )}&select=id,contractor_id,work_submission_id,document_type,file_name,file_path,created_at,auth_user_id&order=created_at.desc`
    );

  return Array.isArray(rows)
    ? rows
    : [];
}


/*
  ============================================================
  LOAD CONTRACTOR WORK COUNT
  ============================================================
*/

async function loadWorkItems(
  contractorId
) {
  const rows =
    await rest(
      `contractor_work_submissions?contractor_id=eq.${encodeURIComponent(
        contractorId
      )}&select=id,property_id,property_address,work_type,completed_date,status,created_at&order=created_at.desc`
    );

  return Array.isArray(rows)
    ? rows
    : [];
}


/*
  ============================================================
  DOCUMENT PRESENCE
  ============================================================
*/

function hasDocumentType(
  documents,
  documentType
) {
  const wanted =
    cleanLower(
      documentType
    );

  return documents.some(
    document =>
      cleanLower(
        document.document_type
      ) === wanted
  );
}


/*
  ============================================================
  FORMAT CONTRACTOR RESPONSE
  ============================================================
*/

function formatContractor(
  contractor,
  documents = [],
  workItems = []
) {
  const licenseUploaded =
    hasDocumentType(
      documents,
      "ROC License Document"
    );

  const insuranceUploaded =
    hasDocumentType(
      documents,
      "Certificate of Insurance"
    );


  let licenseStatus =
    normalizedCredentialStatus(
      contractor.license_status
    );

  let insuranceStatus =
    normalizedCredentialStatus(
      contractor.insurance_status
    );


  /*
    If the credential row exists but an older contractor row
    still says Not Uploaded, show Pending Review rather than
    incorrectly telling the admin that the document is missing.
  */

  if (
    licenseUploaded &&
    licenseStatus ===
      "Not Uploaded"
  ) {
    licenseStatus =
      "Pending Review";
  }

  if (
    insuranceUploaded &&
    insuranceStatus ===
      "Not Uploaded"
  ) {
    insuranceStatus =
      "Pending Review";
  }


  return {
    id:
      contractor.id,

    authUserId:
      contractor.auth_user_id ||
      "",

    businessName:
      contractor.business_name ||
      "",

    contactName:
      contractor.contact_name ||
      "",

    phone:
      contractor.phone ||
      "",

    email:
      contractor.email ||
      "",

    serviceArea:
      contractor.service_area ||
      "",

    licenseNumber:
      contractor.license_number ||
      "",

    licenseStatus,

    insuranceStatus,

    licenseDocumentUploaded:
      licenseUploaded,

    insuranceDocumentUploaded:
      insuranceUploaded,

    overallStatus:
      getOverallStatus({
        ...contractor,

        license_status:
          licenseStatus,

        insurance_status:
          insuranceStatus
      }),

    createdAt:
      contractor.created_at ||
      null,

    documentCount:
      documents.length,

    workCount:
      workItems.length,

    documents,

    workItems
  };
}


/*
  ============================================================
  LIST CONTRACTORS
  ============================================================
*/

async function listContractors() {
  const contractors =
    await rest(
      "contractors?select=*&order=created_at.desc"
    );

  const documents =
    await rest(
      "contractor_documents?select=id,contractor_id,work_submission_id,document_type,file_name,file_path,created_at,auth_user_id&order=created_at.desc"
    );

  const workItems =
    await rest(
      "contractor_work_submissions?select=id,contractor_id,status,created_at"
    );


  const safeContractors =
    Array.isArray(
      contractors
    )
      ? contractors
      : [];

  const safeDocuments =
    Array.isArray(
      documents
    )
      ? documents
      : [];

  const safeWorkItems =
    Array.isArray(
      workItems
    )
      ? workItems
      : [];


  const formatted =
    safeContractors.map(
      contractor => {

        const contractorDocuments =
          safeDocuments.filter(
            document =>
              document.contractor_id ===
              contractor.id
          );

        const contractorWork =
          safeWorkItems.filter(
            item =>
              item.contractor_id ===
              contractor.id
          );

        return formatContractor(
          contractor,
          contractorDocuments,
          contractorWork
        );
      }
    );


  return formatted;
}


/*
  ============================================================
  LOAD SINGLE CONTRACTOR
  ============================================================
*/

async function loadContractor(
  contractorId
) {
  const rows =
    await rest(
      `contractors?id=eq.${encodeURIComponent(
        contractorId
      )}&select=*&limit=1`
    );

  const contractor =
    Array.isArray(rows)
      ? rows[0] || null
      : null;


  if (!contractor) {
    const error =
      new Error(
        "Contractor account was not found."
      );

    error.statusCode =
      404;

    throw error;
  }


  const [
    documents,
    workItems
  ] =
    await Promise.all([
      loadDocuments(
        contractor.id
      ),

      loadWorkItems(
        contractor.id
      )
    ]);


  return formatContractor(
    contractor,
    documents,
    workItems
  );
}


/*
  ============================================================
  CREATE SHORT-LIVED SIGNED DOCUMENT URL
  ============================================================

  contractor-files is private.

  We never return a permanent public URL.

  Signed URL expires after 5 minutes.
*/

async function createSignedDocumentUrl(
  documentId
) {
  const rows =
    await rest(
      `contractor_documents?id=eq.${encodeURIComponent(
        documentId
      )}&select=id,contractor_id,document_type,file_name,file_path,created_at&limit=1`
    );

  const document =
    Array.isArray(rows)
      ? rows[0] || null
      : null;


  if (!document) {
    const error =
      new Error(
        "Contractor document was not found."
      );

    error.statusCode =
      404;

    throw error;
  }


  if (!document.file_path) {
    const error =
      new Error(
        "This contractor document does not have a stored file."
      );

    error.statusCode =
      404;

    throw error;
  }


  const encodedPath =
    encodeStoragePath(
      document.file_path
    );


  const response =
    await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${encodedPath}`,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          apikey:
            SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${SERVICE_ROLE_KEY}`
        },

        body:
          JSON.stringify({
            expiresIn:
              300
          })
      }
    );


  const text =
    await response.text();

  let data = null;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {
    data =
      text;
  }


  if (!response.ok) {
    const error =
      new Error(
        data?.message ||
        data?.error ||
        "BlueVera could not open this contractor document."
      );

    error.statusCode =
      response.status;

    error.details =
      data;

    throw error;
  }


  const signedPath =
    data?.signedURL ||
    data?.signedUrl ||
    data?.signed_url ||
    "";


  if (!signedPath) {
    const error =
      new Error(
        "Supabase did not return a signed contractor document URL."
      );

    error.statusCode =
      500;

    throw error;
  }


  const signedUrl =
    signedPath.startsWith("http")
      ? signedPath
      : `${SUPABASE_URL}/storage/v1${signedPath}`;


  return {
    id:
      document.id,

    contractorId:
      document.contractor_id,

    documentType:
      document.document_type,

    fileName:
      document.file_name,

    signedUrl,

    expiresIn:
      300
  };
}


/*
  ============================================================
  REVIEW CREDENTIAL
  ============================================================
*/

async function reviewCredential(
  contractorId,
  credential,
  decision
) {
  const contractor =
    await loadContractor(
      contractorId
    );


  const normalizedCredential =
    cleanLower(
      credential
    );

  const normalizedDecision =
    cleanLower(
      decision
    );


  if (
    ![
      "license",
      "insurance"
    ].includes(
      normalizedCredential
    )
  ) {
    const error =
      new Error(
        "Credential must be license or insurance."
      );

    error.statusCode =
      400;

    throw error;
  }


  const decisionMap = {
    verified:
      "Verified",

    approved:
      "Verified",

    rejected:
      "Rejected",

    denied:
      "Rejected",

    pending:
      "Pending Review",

    "pending review":
      "Pending Review"
  };


  const newStatus =
    decisionMap[
      normalizedDecision
    ];


  if (!newStatus) {
    const error =
      new Error(
        "Decision must be verified, rejected, or pending."
      );

    error.statusCode =
      400;

    throw error;
  }


  /*
    Require the actual credential document before BlueVera can
    approve it.

    An admin cannot accidentally verify an empty credential.
  */

  if (
    normalizedCredential ===
      "license" &&
    newStatus ===
      "Verified" &&
    !contractor
      .licenseDocumentUploaded
  ) {
    const error =
      new Error(
        "The ROC license document has not been uploaded."
      );

    error.statusCode =
      400;

    throw error;
  }


  if (
    normalizedCredential ===
      "insurance" &&
    newStatus ===
      "Verified" &&
    !contractor
      .insuranceDocumentUploaded
  ) {
    const error =
      new Error(
        "The certificate of insurance has not been uploaded."
      );

    error.statusCode =
      400;

    throw error;
  }


  const updatePayload =
    normalizedCredential ===
      "license"
      ? {
          license_status:
            newStatus
        }
      : {
          insurance_status:
            newStatus
        };


  await rest(
    `contractors?id=eq.${encodeURIComponent(
      contractorId
    )}`,
    {
      method:
        "PATCH",

      headers: {
        Prefer:
          "return=minimal"
      },

      body:
        JSON.stringify(
          updatePayload
        )
    }
  );


  /*
    Reload from Supabase after update so admin page receives the
    authoritative current state.
  */

  return await loadContractor(
    contractorId
  );
}


/*
  ============================================================
  API HANDLER
  ============================================================
*/

export default async function handler(
  req,
  res
) {
  if (
    !SUPABASE_URL ||
    !SERVICE_ROLE_KEY
  ) {
    return send(
      res,
      500,
      {
        success:
          false,

        error:
          "Missing Supabase environment variables."
      }
    );
  }


  if (
    req.method !== "GET" &&
    req.method !== "POST"
  ) {
    return send(
      res,
      405,
      {
        success:
          false,

        error:
          "Method not allowed."
      }
    );
  }


  try {

    /*
      ============================================================
      ADMIN AUTHENTICATION
      ============================================================
    */

    await requireAdminAccess(
      req
    );


    /*
      ============================================================
      GET ACTIONS
      ============================================================
    */

    if (
      req.method === "GET"
    ) {
      const action =
        cleanLower(
          req.query?.action ||
          "list"
        );


      /*
        ----------------------------------------------------------
        LIST ALL CONTRACTORS
        ----------------------------------------------------------
      */

      if (
        action === "list"
      ) {
        const contractors =
          await listContractors();


        const pendingCount =
          contractors.filter(
            contractor =>
              contractor
                .overallStatus ===
              "Pending Review"
          ).length;


        const verifiedCount =
          contractors.filter(
            contractor =>
              contractor
                .overallStatus ===
              "Verified"
          ).length;


        const needsAttentionCount =
          contractors.filter(
            contractor =>
              contractor
                .overallStatus ===
              "Needs Attention" ||
              contractor
                .overallStatus ===
              "Missing Documents"
          ).length;


        return send(
          res,
          200,
          {
            success:
              true,

            counts: {
              total:
                contractors.length,

              pending:
                pendingCount,

              verified:
                verifiedCount,

              needsAttention:
                needsAttentionCount
            },

            contractors
          }
        );
      }


      /*
        ----------------------------------------------------------
        LOAD CONTRACTOR DETAIL
        ----------------------------------------------------------
      */

      if (
        action === "detail"
      ) {
        const contractorId =
          clean(
            req.query?.id
          );


        if (!contractorId) {
          return send(
            res,
            400,
            {
              success:
                false,

              error:
                "Missing contractor ID."
            }
          );
        }


        const contractor =
          await loadContractor(
            contractorId
          );


        return send(
          res,
          200,
          {
            success:
              true,

            contractor
          }
        );
      }


      /*
        ----------------------------------------------------------
        GENERATE PRIVATE DOCUMENT LINK
        ----------------------------------------------------------
      */

      if (
        action === "document"
      ) {
        const documentId =
          clean(
            req.query
              ?.documentId
          );


        if (!documentId) {
          return send(
            res,
            400,
            {
              success:
                false,

              error:
                "Missing contractor document ID."
            }
          );
        }


        const document =
          await createSignedDocumentUrl(
            documentId
          );


        return send(
          res,
          200,
          {
            success:
              true,

            document
          }
        );
      }


      return send(
        res,
        400,
        {
          success:
            false,

          error:
            "Unknown contractor admin action."
        }
      );
    }


    /*
      ============================================================
      POST ACTIONS
      ============================================================
    */

    const {
      action,
      contractorId,
      credential,
      decision
    } =
      req.body || {};


    const cleanAction =
      cleanLower(
        action
      );


    /*
      ------------------------------------------------------------
      REVIEW LICENSE OR INSURANCE
      ------------------------------------------------------------
    */

    if (
      cleanAction === "review"
    ) {
      const cleanContractorId =
        clean(
          contractorId
        );


      if (!cleanContractorId) {
        return send(
          res,
          400,
          {
            success:
              false,

            error:
              "Missing contractor ID."
          }
        );
      }


      const contractor =
        await reviewCredential(
          cleanContractorId,
          credential,
          decision
        );


      return send(
        res,
        200,
        {
          success:
            true,

          message:
            `${clean(credential)} credential status updated.`,

          contractor
        }
      );
    }


    return send(
      res,
      400,
      {
        success:
          false,

        error:
          "Unknown contractor admin action."
      }
    );


  } catch (error) {
    console.error(
      "Admin contractor API error:",
      error
    );


    const statusCode =
      Number(
        error?.statusCode
      );


    return send(
      res,
      (
        statusCode >= 400 &&
        statusCode < 600
      )
        ? statusCode
        : 500,
      {
        success:
          false,

        error:
          error?.message ||
          "BlueVera could not complete the contractor admin request.",

        details:
          error?.details ||
          null
      }
    );
  }
}
