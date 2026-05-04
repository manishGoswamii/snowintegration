import express, { json } from "express";
import multer, { diskStorage } from "multer";
import xlsx from "xlsx";
import { join, extname } from "path";
import { existsSync, mkdirSync } from "fs";
import cors from "cors";
import path from "path";
import { callHuggingFace, callHuggingFaceV2 } from "../services/hf_service.js";
import fs from "fs/promises";

import { prompt } from "../prompt.js";

const app = express();
app.use(cors());
app.use(json());

// Ensure uploads folder exists
const uploadDir = path.join(process.cwd(), "uploads");
if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir);
}

// Multer config
const storage = diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const allowed = [".xlsx", ".xls"];
        const ext = extname(file.originalname).toLowerCase();

        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error("Only Excel files are allowed"));
        }
    }
});

// Parse Excel utility
function parseExcel(filePath) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    return xlsx.utils.sheet_to_json(sheet, {
        defval: "", // Keeps empty cells
        raw: false
    });
}

// Upload endpoint
app.post("/upload-excel", upload.single("file"), async (req, res) => {
    const validateExcelFileStructure = (rows) => {
        const errors = [];
        const actionNames = new Set();

        // Store actions by activity
        const activityActions = {};

        rows.forEach((row, index) => {
            const rowNum = index + 1;
            const activityName = row["activity name"];
            const actionName = row["action name"];

            // -------------------------
            // Common Mandatory Fields
            // -------------------------
            if (!row["catalog item"]) {
                errors.push(`Row ${rowNum}: Catalog Item is required.`);
            }

            if (!activityName) {
                errors.push(`Row ${rowNum}: Activity Name is required.`);
            }

            if (!actionName) {
                errors.push(`Row ${rowNum}: Action Name is required.`);
            }

            // -------------------------
            // Unique Action Name Check
            // -------------------------
            if (actionName) {
                if (actionNames.has(actionName)) {
                    errors.push(`Row ${rowNum}: Action Name '${actionName}' must be unique.`);
                } else {
                    actionNames.add(actionName);
                }
            }

            // -------------------------
            // Track actions within activity
            // -------------------------
            if (activityName) {
                if (!activityActions[activityName]) {
                    activityActions[activityName] = [];
                }

                activityActions[activityName].push({
                    rowNum,
                    actionName,
                    actionType: row["action type"],
                    executionType: row["action execution type"],
                    dependsOnAction: row["depends on action"],
                    executesOn: row["executes on"],
                    executionMode: row["dependent action execution mode"],
                    executionOrder: parseInt(row["execution order"]) || null
                });
            }

            // -------------------------
            // Ask for Approval Validation
            // -------------------------
            if (row["action type"] === "ask for approval") {

                if (!row["approval type"]) {
                    errors.push(`Row ${rowNum}: Approval Type is required for Ask for Approval.`);
                }

                if (
                    row["approval type"] === "user approval - question" ||
                    row["approval type"] === "user approval - name"
                ) {
                    if (!row["approver user"]) {
                        errors.push(`Row ${rowNum}: Approver User is required for User Approval.`);
                    }
                }

                if (
                    row["approval type"] === "group approval - all" ||
                    row["approval type"] === "group approval - any"
                ) {
                    if (!row["approver group"]) {
                        errors.push(`Row ${rowNum}: Approver Group is required for Group Approval.`);
                    }
                }

                // if (!row["end flow - rejected"]) {
                //     errors.push(`Row ${rowNum}: End Flow If Rejected is required.`);
                // }
            }

            // -------------------------
            // Create Task Validation
            // -------------------------
            if (row["action type"] === "create task") {

                if (!row["task assignment group"]) {
                    errors.push(`Row ${rowNum}: Task Assignment Group is required.`);
                }

                if (!row["short description"]) {
                    errors.push(`Row ${rowNum}: Short Description is required.`);
                }

                // if (!row["end flow - not completed"]) {
                //     errors.push(`Row ${rowNum}: End Flow Not Completed is required.`);
                // }
            }

            // -------------------------
            // Dependent Execution Validation
            // -------------------------
            if (row["action execution type"] === "dependent") {

                if (!row["depends on action"]) {
                    errors.push(`Row ${rowNum}: Depends On Action is required.`);
                }

                if (!row["executes on"]) {
                    errors.push(`Row ${rowNum}: Executes On is required.`);
                }

                if (!row["dependent action execution mode"]) {
                    errors.push(`Row ${rowNum}: Dependent Action Execution Mode is required.`);
                }

                // if (!row["execution order"]) {
                //     errors.push(`Row ${rowNum}: Execution Order is required.`);
                // }
            }
        });

        // -------------------------
        // Advanced Dependency Validation
        // -------------------------

        Object.keys(activityActions).forEach(activity => {
            const actions = activityActions[activity];

            const actionMap = {};

            actions.forEach((action, index) => {
                actionMap[action.actionName] = {
                    ...action,
                    position: index
                };
            });

            const sequentialOrders = [];
            const parallelGroups = {};

            actions.forEach(action => {
                if (action.executionType === "dependent") {

                    // -------------------------
                    // Dependency existence
                    // -------------------------
                    if (!actionMap[action.dependsOnAction]) {
                        errors.push(
                            `Row ${action.rowNum}: Depends On Action '${action.dependsOnAction}' does not exist in activity '${activity}'.`
                        );
                    } else {

                        const parentAction = actionMap[action.dependsOnAction];

                        // Must depend only on previous action
                        if (
                            parentAction.position >=
                            actionMap[action.actionName].position
                        ) {
                            errors.push(
                                `Row ${action.rowNum}: Depends On Action must reference a prior action within the same activity.`
                            );
                        }

                        // -------------------------
                        // Executes On validation
                        // -------------------------
                        if (parentAction.actionType === "ask for approval") {
                            const validApprovalStatuses = ["approved", "rejected"];

                            if (!validApprovalStatuses.includes(action.executesOn)) {
                                errors.push(
                                    `Row ${action.rowNum}: Executes On for Ask for Approval dependency must be either Approved or Rejected.`
                                );
                            }
                        }

                        if (parentAction.actionType === "create task") {
                            const validTaskStatuses = ["closed complete", "closed incomplete"];

                            if (!validTaskStatuses.includes(action.executesOn)) {
                                errors.push(
                                    `Row ${action.rowNum}: Executes On for Create Task dependency must be Closed Complete or Closed Incomplete.`
                                );
                            }
                        }
                    }

                    // -------------------------
                    // Sequential validation
                    // -------------------------
                    // if (action.executionMode === "sequential") {

                    //     if (sequentialOrders.includes(action.executionOrder)) {
                    //         errors.push(
                    //             `Row ${action.rowNum}: Sequential dependent actions must have unique execution orders.`
                    //         );
                    //     }

                    //     sequentialOrders.push(action.executionOrder);
                    // }

                    // -------------------------
                    // Parallel validation
                    // -------------------------
                    // if (action.executionMode === "parallel") {

                    //     if (!parallelGroups[action.dependsOnAction]) {
                    //         parallelGroups[action.dependsOnAction] = {};
                    //     }

                    //     if (!parallelGroups[action.dependsOnAction][action.executionOrder]) {
                    //         parallelGroups[action.dependsOnAction][action.executionOrder] = [];
                    //     }

                    //     parallelGroups[action.dependsOnAction][action.executionOrder].push(action);
                    // }
                }
            });

            // -------------------------
            // Sequential orders increasing
            // -------------------------
            // const sortedSequential = [...sequentialOrders].sort((a, b) => a - b);

            // for (let i = 0; i < sequentialOrders.length; i++) {
            //     if (sequentialOrders[i] !== sortedSequential[i]) {
            //         errors.push(
            //             `Activity '${activity}': Sequential dependent actions must have increasing execution order.`
            //         );
            //         break;
            //     }
            // }

            // -------------------------
            // Parallel block validation
            // -------------------------
            // Object.keys(parallelGroups).forEach(depAction => {

            //     Object.keys(parallelGroups[depAction]).forEach(order => {

            //         const actionsInBlock = parallelGroups[depAction][order];

            //         actionsInBlock.forEach(action => {
            //             if (action.executionOrder != parseInt(order)) {
            //                 errors.push(
            //                     `Activity '${activity}': Parallel actions depending on '${depAction}' in block order '${order}' are invalid.`
            //                 );
            //             }
            //         });
            //     });
            // });

        });

        if (errors.length === 0) {
            return {
                isValid: true
            };
        }

        return {
            isValid: false,
            errors
        };
    };

    const createDataValidationPayload = (row, index) => {
        const obj = {};
        obj.rowNumber = index + 1;
        obj.catalogName = row["catalog item"];
        obj.activityName = row["activity name"];
        obj.actionName = row["action name"];
        obj.actionType = row["action type"];
        obj.actionExecutionType = row["action execution type"];
        if (row["action type"] == "ask for approval") {
            obj.approvalType = row["approval type"];
            if (row["approval type"] == "user approval - question" || row["approval type"] == "user approval - name") {
                obj.approverUser = row["approver user"];
            }
            else {
                obj.approverGroup = row["approver group"];
            }
        }
        else if (row["action type"] == "create task") {
            obj.assignmentGroup = row["task assignment group"];
            obj.shortDescription = row["short description"];
        }
        if (row["action execution type"] == "dependent") {
            obj.dependsOnAction = row["depends on action"];
            obj.dependentActionExecutionMode = row["dependent action execution mode"];
            obj.dependentActionExecutionOrder = row["execution order"];
        }
        return obj;
    }

    function buildWorkflowStructure(rows) {
        const activityMap = {};

        rows.forEach((row) => {
            const activityName = row["activity name"];
            const actionName = row["action name"];

            if (!activityName || !actionName) return;

            // Create activity if not exists
            if (!activityMap[activityName]) {
                activityMap[activityName] = {
                    name: activityName,
                    type: "sequential",
                    catalog: row["catalog item"],
                    actions: []
                };
            }

            const action = {
                name: actionName,
                label: row["label"] || row["action name"],
                executionType: row["action execution type"],
                actionType: row["action type"],
                approvalType: row["approval type"] || null,
                approverUser: row["approver user"] || null,
                approverGroup: row["approver group"] || null,
                dependsOnAction: row["depends on action"] || null,
                executesOn: row["executes on"] || null,
                dependentActionExecutionType: row["dependent action execution mode"] || null,
                endFlowOnRejection: row["end flow - rejected"] === "true",
                endFlowOnInCompletion: row["end flow - not completed"] === "true",
                shortDescription: row["short description"] || null,
                assignmentGroup: row["task assignment group"] || null
            };

            activityMap[activityName].actions.push(action);
        });

        return Object.values(activityMap);
    }

    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No file uploaded"
            });
        }

        const filePath = req.file.path;

        const normalizeRow = (row) => {
            const cleaned = {};
            Object.keys(row).forEach(key => {
                const cleanedKey = key.trim().toLowerCase();
                const value = (row[key] && row[key].trim().toLowerCase()) || "";
                cleaned[cleanedKey] = value;
            });

            return cleaned;
        }

        const rows = parseExcel(filePath).map(normalizeRow);

        const validation = validateExcelFileStructure(rows);

        if (!validation.isValid) {
            return res.status(400).json({
                success: false,
                message: `Excel file contains ${validation.errors.length} errors.`,
                errors: validation.errors
            });
        }

        // Validation payload extraction example
        const validationPayload = rows.map(createDataValidationPayload);

        return res.status(200).json({
            success: true,
            fileName: req.file.originalname,
            totalRows: rows.length,
            rawRows: rows,
            validationPayload,
            rows:buildWorkflowStructure(rows)
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

const nlpUpload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const allowed = [".txt", ".docx"];
        const ext = extname(file.originalname).toLowerCase();

        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error("Only .txt and .docx files are allowed"));
        }
    }
});

async function extractRequirementText(filePath, ext) {
    if (ext === ".txt") {
        return await fs.readFile(filePath, "utf-8");
    }

    // if (ext === ".docx") {
    //     const result = await mammoth.extractRawText({ path: filePath });
    //     return result.value;
    // }

    throw new Error("Unsupported file type");
}


app.post("/nlp", nlpUpload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No requirement file uploaded"
            });
        }

        const filePath = req.file.path;
        const ext = extname(req.file.originalname).toLowerCase();

        // Extract plain language text
        const requirements = await extractRequirementText(filePath, ext);

        if (!requirements || requirements.trim() === "") {
            return res.status(400).json({
                success: false,
                message: "Uploaded file is empty"
            });
        }

        // AI prompt
        const apiPrompt = prompt + " Requirements: " + requirements;

        // Hugging Face call
        const aiResponse = await callHuggingFace(apiPrompt);
        return res.json({
            success: true,
            fileName: req.file.originalname,
            aiGeneratedWorkflow: JSON.parse(aiResponse.content)
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

app.post("/nlpV2", async (req, res) => {
    try {

        const requirements = req.body.requirements;

        if (!requirements || !requirements.trim()) {
            return res.status(400).json({
                success: false,
                message: "No requirements provided",
                error: true
            });
        }

        // Clean input text
        const cleanRequirements = requirements
            .replace(/\s+/g, " ")
            .trim();

        // Strong structured prompt
        const apiPrompt = prompt + ". Requirements: " + cleanRequirements;

        const aiResponse = await callHuggingFace(apiPrompt);

        let parsedOutput;

        try {
            parsedOutput = JSON.parse(aiResponse.content);
        } catch (e) {
            return res.status(500).json({
                success: false,
                error: true,
                message: parsedOutput.reason || parsedOutput.message,
                status: 500
            });
        }

        if (parsedOutput.isValid) {
            return res.status(200).json({
                success: true,
                error: false,
                content: parsedOutput.content,
                message: parsedOutput.reason || parsedOutput.message,
                status: 200
            });
        }
        return res.status(400).json({
            success: false,
            error: true,
            content: parsedOutput.content,
            message: parsedOutput.reason || parsedOutput.message,
            status: 400
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            success: false,
            error: true,
            message: error.message,
            status: 500
        });
    }
});


/*
app.post("/nlpV3", async (req, res) => {
    try {

        const requirements = req.body.requirements;

        if (!requirements || !requirements.trim()) {
            return res.status(400).json({
                success: false,
                message: "No requirements provided",
                error:true
            });
        }

        // Clean input text
        const cleanRequirements = requirements
            .replace(/\s+/g, " ")
            .trim();

        // Strong structured prompt
        const apiPrompt = prompt + ". Requirements: " + cleanRequirements;

                // Call Hugging Face correctly
        const aiResponse = await callHuggingFaceV2({
            model: "Qwen/Qwen3.5-9B:together",
            messages: [
                {
                    role: "user",
                    content: apiPrompt,
                },
            ],
        });
        
        console.log(aiResponse);
        let parsedOutput;

        try {
            parsedOutput = JSON.parse(aiResponse.content);
        } catch (e) {
            return res.status(500).json({
                success: false,
                error:true,
                message:  parsedOutput.reason || parsedOutput.message ,
                status:500
            });
        }

        if(parsedOutput.isValid){
            return res.status(200).json({
                success: true,
                error:false,
                content: parsedOutput.content,
                message:  parsedOutput.reason || parsedOutput.message ,
                status:200
            });
        }
        return res.status(400).json({
            success: false,
            error:true,
            content:parsedOutput.content,
            message:  parsedOutput.reason || parsedOutput.message ,
            status:400
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            success: false,
            error:true,
            message: error.message,
            status:500
        });
    }
});
*/



// Health check
app.get("/health", (req, res) => {
    res.json({
        error: false,
        success: true,
        message: "Excel parser service is running"
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
