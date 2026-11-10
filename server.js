const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURACIÓN DE VARIABLES DE ENTORNO (0 COSTO) ---
const PORT = process.env.PORT || 3000;
const MIGO_INSTANCE = process.env.MIGO_INSTANCE || "eea35323-c978-443c-b00d-6ba5ee3ddc9b"; // Genarito: 947836063
const MIGO_API_KEY = process.env.MIGO_API_KEY || "EB08E3C1-0DF4-48DD-9EB5-19D26053D94A";
const MIGO_DNI_TOKEN = process.env.MIGO_DNI_TOKEN || "CSqZeeppmaJm4sxZUsSIUerIcz61PPFnmuOsWyq6GSybBWf0cN0wW7QKaF1u";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyCv0eXHXTr6rf9cqRDuI79P5CZJngXcEXE";

// --- INICIALIZACIÓN DE FIREBASE (PROYECTO: iee-genaro-herrera) ---
try {
    if (!admin.apps.length) {
        let credential;
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            let saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (!saJson.trim().startsWith('{')) {
                saJson = Buffer.from(saJson, 'base64').toString('utf-8');
            }
            credential = admin.credential.cert(JSON.parse(saJson));
        } else {
            const localKeyPath = path.join(__dirname, 'serviceAccountKey.json');
            if (fs.existsSync(localKeyPath)) {
                credential = admin.credential.cert(require(localKeyPath));
            } else {
                console.warn("⚠️ No se encontró serviceAccountKey.json ni FIREBASE_SERVICE_ACCOUNT en entorno.");
            }
        }

        if (credential) {
            admin.initializeApp({ credential });
            console.log("🔥 Conectado exitosamente a Firebase Firestore (iee-genaro-herrera).");
        }
    }
} catch (e) {
    console.error("❌ Error inicializando Firebase:", e.message);
}

const db = admin.apps.length ? admin.firestore() : null;

// Caché de contexto para no saturar lecturas en Firestore
let aiMemoryCache = {
    compiledContext: "",
    lastFetch: 0
};

// Formato de fecha para Perú (America/Lima)
function getFormattedDate(date = new Date()) {
    try {
        const formatter = new Intl.DateTimeFormat('es-PE', {
            timeZone: 'America/Lima',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        return formatter.format(date);
    } catch (e) {
        const d = date.getDate().toString().padStart(2, '0');
        const m = (date.getMonth() + 1).toString().padStart(2, '0');
        const y = date.getFullYear();
        return `${d}/${m}/${y}`;
    }
}

// Envío de WhatsApp a través de Migo API
async function enviarWhatsAppMigo(phone, message) {
    let cleanPhone = phone ? phone.toString().trim() : '';
    if (!cleanPhone.endsWith('@lid')) {
        cleanPhone = cleanPhone.replace(/\D/g, '');
        if (cleanPhone.length === 9) cleanPhone = '51' + cleanPhone;
    }

    console.log(`📤 Enviando WhatsApp a ${cleanPhone}...`);

    try {
        const response = await fetch(`https://chat.migo.pe/message/sendText/${MIGO_INSTANCE}`, {
            method: 'POST',
            headers: {
                'apikey': MIGO_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                number: cleanPhone,
                text: message
            })
        });

        const data = await response.json();
        console.log(`✅ Respuesta de Migo:`, JSON.stringify(data));
        return { success: true, data };
    } catch (error) {
        console.error('❌ Error en enviarWhatsAppMigo:', error.message);
        return { success: false, error: error.message };
    }
}

// Registro en memoria de últimas peticiones para diagnóstico en tiempo real
const requestLogs = [];

function recordIncoming(req, note = '') {
    const entry = {
        time: new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima' }),
        method: req.method,
        url: req.originalUrl || req.url,
        body: req.body,
        note: note
    };
    requestLogs.unshift(entry);
    if (requestLogs.length > 50) requestLogs.pop();
}

// ==========================================
//   RUTAS DE SALUD Y VERIFICACIÓN
// ==========================================
app.get('/', (req, res) => {
    res.json({
        status: "online",
        name: "Genarito Cloud Assistant - I.E.E. Genaro Herrera",
        platform: "Render Free Tier (0 Cost)",
        time: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.send("OK");
});

app.get('/logs', (req, res) => {
    res.json({
        total: requestLogs.length,
        logs: requestLogs
    });
});

// Manejador centralizado para webhooks (acepta POST en /webhook/migo, /webhook y /)
async function handleWebhook(req, res) {
    recordIncoming(req, 'Incoming webhook');
    // Respondemos de inmediato a Migo para evitar timeouts de red
    res.status(200).send({ status: 'ok' });

    try {
        console.log("📦 [WEBHOOK INCOMING]:", JSON.stringify(req.body, null, 2));

        const body = req.body || {};
        const data = body.data || {};
        const key = data.key || body.key || {};

        // 🛡️ Ignorar ÚNICAMENTE mensajes que el bot se envió a sí mismo
        if (key.fromMe === true || body.fromMe === true) {
            console.log("ℹ️ Mensaje ignorado: enviado por el propio bot (fromMe=true)");
            return;
        }

        // Obtener número del remitente (soporta múltiples formatos de Migo)
        let fromPhone = "";
        if (key.remoteJid) fromPhone = key.remoteJid;
        else if (body.from) fromPhone = body.from;
        else if (body.number) fromPhone = body.number;
        else if (body.phone) fromPhone = body.phone;
        else if (data.from) fromPhone = data.from;
        else if (body.sender) fromPhone = body.sender;

        // Extraer texto del mensaje
        const msg = body.message || data.message || {};
        let rawText = body.text || body.body || body.message || msg.conversation || 
                      (msg.extendedTextMessage && msg.extendedTextMessage.text) || 
                      (data.text) || "";

        if (typeof rawText === 'object') {
            rawText = rawText.text || rawText.body || rawText.conversation || "";
        }

        if (typeof fromPhone === 'string' && fromPhone.endsWith('@lid')) {
            fromPhone = fromPhone.trim();
        } else {
            fromPhone = fromPhone.toString().replace(/\D/g, '');
        }

        if (!fromPhone || !rawText) {
            console.log(`⚠️ Salida temprana - Datos incompletos: phone="${fromPhone}", text="${rawText}"`);
            return;
        }

        console.log(`💬 [BOT] Mensaje validado de ${fromPhone}: "${rawText}"`);

        if (!db) {
            console.error("❌ Base de datos no conectada");
            await enviarWhatsAppMigo(fromPhone, "Hola, estoy iniciando mi sistema en la nube. Por favor, reenvía tu mensaje en un instante.");
            return;
        }

        // CARGAR O CREAR SESIÓN EN FIRESTORE
        const sessionRef = db.collection('bot_sessions').doc(fromPhone);
        const sessionDoc = await sessionRef.get();
        let session = sessionDoc.exists ? sessionDoc.data() : { state: 'START', phone: fromPhone };

        const todayDateStr = getFormattedDate(new Date());
        let lastActiveDateStr = session.lastActiveDate || null;

        if (!lastActiveDateStr && session.updatedAt) {
            try {
                const updatedDate = (session.updatedAt && typeof session.updatedAt.toDate === 'function') 
                    ? session.updatedAt.toDate() 
                    : new Date(session.updatedAt);
                lastActiveDateStr = getFormattedDate(updatedDate);
            } catch (e) {
                console.error("Error parseando updatedAt:", e.message);
            }
        }

        // CIERRE AUTOMÁTICO DIARIO DE CONVERSACIONES
        if (sessionDoc.exists && lastActiveDateStr && lastActiveDateStr !== todayDateStr) {
            console.log(`🌅 [NUEVO DÍA] Sesión expirada para ${fromPhone}. Día anterior: ${lastActiveDateStr}, Hoy: ${todayDateStr}`);

            if (session.name && session.dni) {
                session = {
                    state: 'VERIFIED',
                    phone: fromPhone,
                    dni: session.dni,
                    name: session.name,
                    chatHistory: '',
                    lastActiveDate: todayDateStr
                };

                await sessionRef.set({
                    state: 'VERIFIED',
                    dni: session.dni,
                    name: session.name,
                    chatHistory: '',
                    lastActiveDate: todayDateStr,
                    targetStudentDni: admin.firestore.FieldValue.delete(),
                    targetStudentName: admin.firestore.FieldValue.delete(),
                    targetStudentGrade: admin.firestore.FieldValue.delete(),
                    targetStudentSection: admin.firestore.FieldValue.delete(),
                    justificationDate: admin.firestore.FieldValue.delete(),
                    justificationReason: admin.firestore.FieldValue.delete(),
                    kidsList: admin.firestore.FieldValue.delete(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                const inputClean = rawText.trim().toLowerCase();
                const saludos = ['hola', 'buenos dias', 'buenos días', 'buenas', 'que tal', 'qué tal', 'buenas tardes', 'buenas noches', 'genarito', 'buen dia', 'buen día'];
                if (saludos.includes(inputClean)) {
                    const saludoNuevoDia = `¡Hola, Sr(a). *${session.name}*! ☀️ Que tenga un buen día.\n\nSoy *Genarito*, el Asistente Virtual de la I.E.E. Genaro Herrera. ¿En qué le puedo ayudar hoy?\n\nPuede consultarme sobre *horarios*, *tutores*, consultar la *asistencia* de su hijo(a) o registrar una *justificación*.`;
                    await enviarWhatsAppMigo(fromPhone, saludoNuevoDia);
                    return;
                }
            } else {
                session = { state: 'START', phone: fromPhone, lastActiveDate: todayDateStr };
                await sessionRef.set({
                    state: 'START',
                    lastActiveDate: todayDateStr,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        }

        const input = rawText.trim().toLowerCase();

        // LÓGICA DE RESETEO (CANCELAR / SALIR / HOLA)
        if ((input === 'cancelar' || input === 'salir' || input === 'menu' || input === 'hola') && session.state !== 'START' && session.state !== 'VERIFIED') {
            console.log(`🏠 [RESET] Usuario ${fromPhone} solicitó reset via: ${input}`);
            await sessionRef.set({ 
                state: 'VERIFIED', 
                lastActiveDate: todayDateStr,
                targetStudentDni: admin.firestore.FieldValue.delete(),
                targetStudentName: admin.firestore.FieldValue.delete(),
                targetStudentGrade: admin.firestore.FieldValue.delete(),
                targetStudentSection: admin.firestore.FieldValue.delete(),
                justificationDate: admin.firestore.FieldValue.delete(),
                justificationReason: admin.firestore.FieldValue.delete(),
                kidsList: admin.firestore.FieldValue.delete(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp() 
            }, { merge: true });
            await enviarWhatsAppMigo(fromPhone, "✅ Trámite cancelado. He regresado al menú principal. ¿En qué más puedo ayudarte?");
            return;
        }

        // --- ESTADO 1: SOLICITAR DNI ---
        if (session.state === 'START') {
            const welcomeMsg = "¡Hola! 🛡️ Soy *Genarito*, el Asistente Virtual de la I.E.E. Genaro Herrera.\n\nPara ayudarte con cualquier trámite o información, por favor bríndame tu número de **DNI**.";
            await enviarWhatsAppMigo(fromPhone, welcomeMsg);
            await sessionRef.set({ state: 'AWAITING_DNI', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            return;
        }

        // --- ESTADO 2: VALIDAR DNI CON RENIEC (MIGO) ---
        if (session.state === 'AWAITING_DNI') {
            const dni = rawText.trim().replace(/\D/g, '');
            if (dni.length !== 8) {
                await enviarWhatsAppMigo(fromPhone, "⚠️ El DNI debe tener 8 dígitos. Por favor, envíalo de nuevo.");
                return;
            }

            const dniRes = await fetch(`https://api.migo.pe/api/v2/dni/${dni}`, {
                method: 'GET',
                headers: { 
                    'Authorization': `Bearer ${MIGO_DNI_TOKEN}`, 
                    'Accept': 'application/json' 
                }
            });
            
            const dniData = await dniRes.json();
            console.log("🔍 [API DNI RESPUESTA]:", JSON.stringify(dniData));

            if (dniData.success) {
                const fullName = dniData.nombre;
                const greetMsg = `Hola, Sr(a). *${fullName}*. ✅ Identidad verificada.\n\nSoy *Genarito*. ¿En qué puedo ayudarte? Puedes preguntarme por tutores, horarios o incluso puedes enviarme una *justificación* si tu hijo(a) no asistió hoy.`;
                await enviarWhatsAppMigo(fromPhone, greetMsg);
                
                await sessionRef.set({ 
                    state: 'VERIFIED', 
                    dni: dni, 
                    name: fullName,
                    lastActiveDate: todayDateStr,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp() 
                });
            } else {
                await enviarWhatsAppMigo(fromPhone, "❌ No pudimos validar ese DNI. Por favor, asegúrate de que sea correcto e inténtalo de nuevo.");
            }
            return;
        }

        // --- ESTADO 3: ATENCIÓN CON IA (GEMINI) ---
        if (session.state === 'VERIFIED') {
            
            if (Date.now() - aiMemoryCache.lastFetch > 3600000) {
                let staffText = "TUTORES 2026:\n";
                const staffSnap = await db.collection('staff_assignments').get();
                staffSnap.forEach(d => {
                    const t = d.data();
                    staffText += `${t.grade}${t.section}: ${t.teacherName} (${t.phone || 'Sin número'})\n`;
                });

                let feesText = "\nCOSTOS DE TRÁMITES (TARIFARIO 2026):\n";
                const feesSnap = await db.collection('administrative_fees').get();
                feesSnap.forEach(d => {
                    const f = d.data();
                    feesText += `- ${f.name}: S/ ${f.price}. ${f.notes}\n`;
                });

                let schedText = "\nHORARIOS ACADÉMICOS (PROFESORES POR AULA):\n";
                const schedSnap = await db.collection('schedules').get();
                schedSnap.forEach(d => {
                    const s = d.data();
                    schedText += `${s.grade}${s.section} | Curso: ${s.subject} -> Docente: ${s.teacherName}\n`;
                });

                aiMemoryCache.compiledContext = staffText + feesText + schedText;
                aiMemoryCache.lastFetch = Date.now();
                console.log("🔄 Caché Global de IA actualizado desde Firestore.");
            }

            if (rawText.toLowerCase().includes('justificar') || rawText.toLowerCase().includes('justificación') || rawText.toLowerCase().includes('justificacion')) {
                await sessionRef.set({ 
                    state: 'AWAITING_JUSTIFICATION_DNI',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp() 
                }, { merge: true });
                await enviarWhatsAppMigo(fromPhone, "Perfecto. 📝 Vamos a registrar una justificación.\n\nPor favor, bríndame el **DNI del estudiante** que deseas justificar:");
                return;
            }

            if (rawText.toLowerCase().includes('asistencia') || rawText.toLowerCase().includes('asistio') || rawText.toLowerCase().includes('asistió')) {
                await sessionRef.set({ 
                    state: 'AWAITING_ATTENDANCE_DNI',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp() 
                }, { merge: true });
                await enviarWhatsAppMigo(fromPhone, "Perfecto. 🛡️ Para consultar la asistencia, por favor bríndame el **DNI del estudiante**:");
                return;
            }

            const prompt = `
                Eres *Genarito*, el Asistente Virtual oficial de la I.E.E. Genaro Herrera (IEE G.H.).
                Tu objetivo es ayudar a padres y alumnos con información exacta sobre horarios, docentes y trámites.
                ESTÁS HABLANDO CON: ${session.name} (DNI ${session.dni}).
                
                CONOCIMIENTO DISPONIBLE:
                ${aiMemoryCache.compiledContext}
                
                REGLAS CRÍTICAS DE PRECISIÓN:
                1. NUNCA adivines un profesor, curso o tutor. Usa ÚNICAMENTE la base de datos entregada arriba.
                2. Si te preguntan "¿Quién le enseña Sociales a mi hijo?" debes responder SIEMPRE preguntando: "¿De qué grado y sección, por favor?".
                3. Si te preguntan por "Certificados de Estudios", debes responder SIEMPRE preguntando: "¿De qué años necesitas el certificado?".
                4. Responde de forma cordial, paciente e inteligente. Tienes historial de conversación.
                5. IMPORTANTE: Si el usuario quiere JUSTIFICAR una falta, instrúyele que escriba la palabra "justificar".
                6. IMPORTANTE: Si el usuario quiere saber la ASISTENCIA, instrúyele que escriba la palabra "asistencia".
                7. FALLBACK: Si no sabes algo no listado, responde EXACTAMENTE: "No tengo esa información, pero daré aviso a mis colaboradores para su implementación."
                
                HISTORIAL RECIENTE DE LA CONVERSACIÓN:
                ${session.chatHistory || "No hay mensajes anteriores."}
                
                PREGUNTA DEL USUARIO: ${rawText}
            `;

            console.log("📝 Consultando Gemini Flash Lite...");
            let responseAI = "Lo siento, Genarito tiene un problema momentáneo. Intenta de nuevo en unos minutos.";

            try {
                const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }]
                    })
                });

                const aiData = await aiResponse.json();
                if (aiData.candidates && aiData.candidates[0] && aiData.candidates[0].content) {
                    responseAI = aiData.candidates[0].content.parts[0].text;
                } else if (aiData.error) {
                    console.error("❌ Error de Gemini API:", aiData.error);
                    responseAI = "Genarito está procesando varias solicitudes. Por favor, reenvía tu mensaje en un minuto.";
                }
            } catch (aiErr) {
                console.error("❌ Error fetch Gemini:", aiErr.message);
                responseAI = "Error momentáneo de conexión con el cerebro de Genarito.";
            }

            let newHistory = (session.chatHistory || "") + `\nUsuario: ${rawText}\nBot: ${responseAI}\n`;
            if (newHistory.length > 1500) newHistory = newHistory.substring(newHistory.length - 1500);

            await sessionRef.set({ 
                chatHistory: newHistory,
                lastActiveDate: todayDateStr,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            await enviarWhatsAppMigo(fromPhone, responseAI);
            return;
        }

        // --- FLUJO DE JUSTIFICACIONES ---
        if (session.state === 'AWAITING_JUSTIFICATION_DNI') {
            const dni = rawText.trim().replace(/\D/g, '');
            console.log(`🔍 Buscando estudiante DNI: ${dni}`);

            let studentSnap = await db.collection('students').where('studentDni', '==', dni).get();
            if (studentSnap.empty) studentSnap = await db.collection('students').where('dni', '==', dni).get();
            if (studentSnap.empty) studentSnap = await db.collection('students').where('id', '==', dni).get();
            if (studentSnap.empty) {
                const dniNum = parseInt(dni);
                if (!isNaN(dniNum)) {
                    studentSnap = await db.collection('students').where('studentDni', '==', dniNum).get();
                    if (studentSnap.empty) studentSnap = await db.collection('students').where('id', '==', dniNum).get();
                }
            }

            if (studentSnap.empty) {
                await enviarWhatsAppMigo(fromPhone, "😔 No encontré a ningún estudiante con ese DNI. Por favor, verifícalo y envíalo nuevamente.");
                return;
            }

            const s = studentSnap.docs[0].data();
            const studentName = s.studentName || s.name || s.n || "Estudiante";
            const studentGrade = s.grade || s.g || "";
            const studentSection = s.section || s.s || "";

            await sessionRef.set({ 
                state: 'CONFIRMING_JUSTIFICATION_STUDENT',
                targetStudentDni: dni,
                targetStudentName: studentName,
                targetStudentGrade: studentGrade,
                targetStudentSection: studentSection,
                updatedAt: admin.firestore.FieldValue.serverTimestamp() 
            }, { merge: true });

            const msj = `He encontrado a:\n👤 *${studentName}*\n🎓 *${studentGrade} "${studentSection}"*\n\n¿Es correcto? (Responde con **Sí** o **No**)`;
            await enviarWhatsAppMigo(fromPhone, msj);
            return;
        }

        if (session.state === 'CONFIRMING_JUSTIFICATION_STUDENT') {
            const resp = rawText.toLowerCase();
            if (resp.includes('si') || resp.includes('sí')) {
                await sessionRef.set({ 
                    state: 'AWAITING_JUSTIFICATION_DATE',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp() 
                }, { merge: true });
                await enviarWhatsAppMigo(fromPhone, "¿Para qué fecha es la justificación? 📅\n\nResponde con **Hoy**, **Ayer** o escribe la fecha específica (ej: 14 de abril).");
            } else {
                await sessionRef.set({ 
                    state: 'AWAITING_JUSTIFICATION_DNI',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp() 
                }, { merge: true });
                await enviarWhatsAppMigo(fromPhone, "Entendido. Por favor, bríndame el **DNI correcto** del estudiante:");
            }
            return;
        }

        if (session.state === 'AWAITING_JUSTIFICATION_DATE') {
            let targetDate = "";
            const input = rawText.toLowerCase().trim();
            const now = new Date();
            
            if (input === 'hoy') {
                targetDate = getFormattedDate(now);
            } else if (input === 'ayer') {
                const yesterday = new Date(now.getTime() - 86400000);
                targetDate = getFormattedDate(yesterday);
            } else {
                try {
                    const datePrompt = `Convierte esta descripción de fecha a formato DD/MM/YYYY. Responde ÚNICAMENTE con la fecha resultante o la palabra "ERROR" si no es válida. FECHA: ${rawText}. Hoy es ${getFormattedDate(now)}`;
                    const aiResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts: [{ text: datePrompt }] }] })
                    });
                    const aiData = await aiResp.json();
                    const parsed = aiData.candidates[0].content.parts[0].text.trim();
                    targetDate = (parsed === "ERROR" || !parsed.includes('/')) ? getFormattedDate(now) : parsed;
                } catch (e) {
                    targetDate = getFormattedDate(now);
                }
            }

            await sessionRef.set({ 
                state: 'AWAITING_JUSTIFICATION_REASON',
                justificationDate: targetDate,
                updatedAt: admin.firestore.FieldValue.serverTimestamp() 
            }, { merge: true });
            await enviarWhatsAppMigo(fromPhone, `Entendido, para el día **${targetDate}**. Ahora, por favor escribe el **motivo** de la inasistencia:`);
            return;
        }

        if (session.state === 'AWAITING_JUSTIFICATION_REASON') {
            const reason = rawText.trim();
            await sessionRef.set({ 
                state: 'AWAITING_JUSTIFICATION_EVIDENCE',
                justificationReason: reason,
                updatedAt: admin.firestore.FieldValue.serverTimestamp() 
            }, { merge: true });
            await enviarWhatsAppMigo(fromPhone, "✅ Motivo registrado. Por último, si tienes una **foto de la evidencia** (receta médica, constancia, etc.), envíala ahora.\n\nSi no tienes una foto, solo escribe la palabra: **Listo**.");
            return;
        }

        if (session.state === 'AWAITING_JUSTIFICATION_EVIDENCE') {
            const mediaUrl = (req.body.data && req.body.data.message && req.body.data.message.mediaUrl) || null;
            const todayStr = session.justificationDate || getFormattedDate(new Date());
            const justifId = `BOT_${new Date().getTime()}_${session.targetStudentDni}`;

            await db.collection('justificantes').doc(justifId).set({
                studentDni: session.targetStudentDni,
                studentName: session.targetStudentName,
                grade: session.targetStudentGrade,
                section: session.targetStudentSection,
                date: todayStr,
                reason: session.justificationReason,
                evidenceUrl: mediaUrl,
                status: 'pending_review',
                parentPhone: fromPhone,
                parentDni: session.dni,
                parentName: session.name,
                assistant: 'Genarito (Bot Render)',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                source: 'whatsapp'
            });

            await sessionRef.set({ 
                state: 'VERIFIED', 
                updatedAt: admin.firestore.FieldValue.serverTimestamp() 
            }, { merge: true });

            const msjFinal = `⭐ ¡Listo! Hemos recibido la justificación de *${session.targetStudentName}*.\n\nLa Coordinación de TOE revisará la información. Te avisaremos por este medio cuando sea aprobada. 🛡️`;
            await enviarWhatsAppMigo(fromPhone, msjFinal);
            return;
        }

        // --- FLUJO DE CONSULTA DE ASISTENCIA ---
        if (session.state === 'AWAITING_ATTENDANCE_DNI') {
            const dni = rawText.trim().replace(/\D/g, '');
            let studentSnap = await db.collection('students').where('studentDni', '==', dni).get();
            if (studentSnap.empty) studentSnap = await db.collection('students').where('dni', '==', dni).get();
            if (studentSnap.empty) studentSnap = await db.collection('students').where('id', '==', dni).get();
            if (studentSnap.empty) {
                const dniNum = parseInt(dni);
                if (!isNaN(dniNum)) {
                    studentSnap = await db.collection('students').where('studentDni', '==', dniNum).get();
                    if (studentSnap.empty) studentSnap = await db.collection('students').where('id', '==', dniNum).get();
                }
            }

            if (studentSnap.empty) {
                await enviarWhatsAppMigo(fromPhone, "😔 No encontré a ningún estudiante con ese DNI. Por favor, verifícalo y envíalo nuevamente.");
                return;
            }

            const s = studentSnap.docs[0].data();
            const studentName = s.studentName || s.name || s.n || "Estudiante";
            await sessionRef.set({ 
                state: 'AWAITING_ATTENDANCE_OPTION',
                targetStudentDni: dni,
                targetStudentName: studentName,
                updatedAt: admin.firestore.FieldValue.serverTimestamp() 
            }, { merge: true });

            const msj = `He encontrado a: *${studentName}*.\n\n¿Qué información deseas?\n\n1. Ver reporte de asistencia QR (Hoy/Ayer).\n2. Ayuda para instalar la App en mi celular.`;
            await enviarWhatsAppMigo(fromPhone, msj);
            return;
        }

        if (session.state === 'AWAITING_ATTENDANCE_OPTION') {
            const opt = rawText.trim().toLowerCase();
            
            if (opt === '1' || opt.includes('asistencia') || opt.includes('reporte')) {
                const dniStr = String(session.targetStudentDni || '').trim();
                const dniNum = parseInt(dniStr, 10);
                let records = [];

                try {
                    const snap1 = await db.collection('attendance').where('dni', '==', dniStr).get();
                    snap1.forEach(doc => records.push({ id: doc.id, ...doc.data() }));

                    if (!isNaN(dniNum)) {
                        const snap2 = await db.collection('attendance').where('dni', '==', dniNum).get();
                        snap2.forEach(doc => {
                            if (!records.some(r => r.id === doc.id)) {
                                records.push({ id: doc.id, ...doc.data() });
                            }
                        });
                    }
                } catch (qErr) {
                    console.error('⚠️ Error consultando asistencia:', qErr.message);
                }

                if (records.length === 0) {
                    await enviarWhatsAppMigo(fromPhone, `El estudiante *${session.targetStudentName}* no registra asistencias recientes en el sistema QR todavía.`);
                } else {
                    records.sort((a, b) => {
                        const tA = (a.timestamp && typeof a.timestamp.toMillis === 'function') 
                            ? a.timestamp.toMillis() 
                            : (a.timestamp && a.timestamp._seconds ? a.timestamp._seconds * 1000 : 0);
                        const tB = (b.timestamp && typeof b.timestamp.toMillis === 'function') 
                            ? b.timestamp.toMillis() 
                            : (b.timestamp && b.timestamp._seconds ? b.timestamp._seconds * 1000 : 0);
                        return tB - tA;
                    });

                    const recent = records.slice(0, 2);
                    let report = `📊 *Reporte de Asistencia:* ${session.targetStudentName}\n\n`;
                    recent.forEach(d => {
                        const typeStr = (d.type || 'registro').toLowerCase();
                        const emoji = typeStr === 'ingreso' ? '📥' : '📤';
                        report += `${emoji} *${typeStr.toUpperCase()}*\n📅 Fecha: ${d.displayDate || 'Hoy'}\n⏰ Hora: ${d.displayTime || '---'}\n`;
                        if (d.status) report += `📍 Estado: ${d.status}\n`;
                        report += '\n';
                    });
                    report += "¿En qué más puedo ayudarte? (Escribe 'salir' para volver al menú principal)";
                    await enviarWhatsAppMigo(fromPhone, report);
                }
                await sessionRef.set({ state: 'VERIFIED' }, { merge: true });
            } else if (opt === '2' || opt.includes('app') || opt.includes('instalar')) {
                const manual = `📱 *INSTALACIÓN DE APP DE ALERTAS GH*\n\n*1.* Entra a: https://alertas.ieegenaroherrera.com\n*2.* Dale en *INSTALAR APP GRATUITA*.\n*3.* Espera un minuto, la app saldrá en tu pantalla como *ALERTAS GENARO*.\n*4.* Abre la APP y dale en *ACTIVAR ALERTAS GH* (Cuadro amarillo) y luego en *PERMITIR NOTIFICACIONES*.\n*5.* El botón cambiará a *SISTEMA ACTIVADO* (Verde).\n*6.* Pon el DNI de tu estudiante. Su nombre saldrá automáticamente.\n*7.* Dale en el botón *ESTE ES MI HIJO(A)-VINCULAR* (Amarillo).\n*8.* ¡Listo! Podrás ver su Récord de Asistencia, Incidencias y Comunicados.\n\nOJO: Esta app es más rápida y segura que WhatsApp. ¿Deseas ayuda con algo más?`;
                await enviarWhatsAppMigo(fromPhone, manual);
                await sessionRef.set({ state: 'VERIFIED' }, { merge: true });
            } else {
                await enviarWhatsAppMigo(fromPhone, "⚠️ Por favor, elige una opción válida: *1* para asistencia o *2* para ayuda con la App.");
            }
            return;
        }

    } catch (error) {
        console.error('❌ Error en procesamiento de Webhook:', error.message);
    }
}

// Escuchar en todas las variantes posibles de endpoint
app.all('/webhook/migo', handleWebhook);
app.all('/webhook', handleWebhook);
app.all('/api/webhook', handleWebhook);
app.post('/', handleWebhook);

if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`🚀 Servidor Genarito Cloud escuchando en el puerto ${PORT}`);
        console.log(`📡 Endpoints habilitados: /webhook/migo, /webhook, /api/webhook, /`);
    });
}

module.exports = app;
