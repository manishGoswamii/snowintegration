import express, { json } from "express";
import multer, { diskStorage } from "multer";
import xlsx from "xlsx";
import { join, extname } from "path";
import { existsSync, mkdirSync } from "fs";
import cors from "cors";
import path from "path";
const app = express();
app.use(cors());
app.use(json());

// Ensure uploads folder exists
const uploadDir =  path.dirname("__dirname") + "/uploads";
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
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No file uploaded"
            });
        }

        const filePath = req.file.path;

        const normalizeRow = (row)=>{
            const cleaned = {};
            Object.keys(row).forEach(key=>{
                const cleanedKey = key.trim().toLowerCase();
                const value = (row[key] && row[key].trim().toLowerCase()) || "";
                cleaned[cleanedKey] = value;
            });

            return cleaned;
        }

        // Parse rows
        const rows = parseExcel(filePath).map(normalizeRow);

        // Validation payload extraction example
        const validationPayload = rows.map((row, index) => {

            const obj = {};
            obj.rowNumber =  index + 1;
            obj.catalogName = row["catalog item"];
            obj.activityName = row["activity name"];
            obj.actionName =  row["action name"] ;
            obj.actionType = row["action type"] ;
            obj.actionExecutionType = row["action execution type"];
            if(row["action type"] == "ask for approval"){
                obj.approvalType = row["approval type"];
                if(row["approval type"]=="user approval - question" || row["approval type"]=="user approval - name"){
                    obj.approverUser = row["approver user"];
                }
                else{
                    obj.approverGroup = row["approver group"];
                }
            }
            else if(row["action type"] == "create task"){                
                obj.assignmentGroup = row["task assignment group"];
                obj.shortDescription = row["short description"];
            }
            if(row["action execution type"]=="dependent"){
                obj.dependsOnAction = row["depends on action"];
                obj.dependentActionExecutionMode = row["dependent action execution mode"];
                obj.dependentActionExecutionOrder = row["execution order"];
            }
            return obj;
        });

        return res.json({
            success: true,
            fileName: req.file.originalname,
            totalRows: rows.length,
            rawRows: rows,
            validationPayload
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Health check
app.get("/health", (req, res) => {
    res.json({
        success: true,
        message: "Excel parser service is running"
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
