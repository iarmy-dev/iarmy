// pdf.js - Génération PDF comptable
const PDFDocument = require('pdfkit');
const { getMonthDataForPDF, getMonthRecap } = require('./sheets');

const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 
                'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

function formatMontant(montant) {
  if (!montant || isNaN(montant)) return '0 €';
  return montant.toLocaleString('fr-FR') + ' €';
}

async function generatePDF(date) {
  const data = await getMonthDataForPDF(date);
  const recap = await getMonthRecap(date);
  
  const monthName = MONTHS[date.getMonth()];
  const year = date.getFullYear();
  
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ 
        size: 'A4', 
        margin: 40,
        info: {
          Title: `Compta ${monthName} ${year}`,
          Author: 'IArmy Compta'
        }
      });
      
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      
      // ===== EN-TÊTE =====
      doc.fontSize(20).font('Helvetica-Bold')
         .text(`Récapitulatif Comptable`, { align: 'center' });
      
      doc.fontSize(16).font('Helvetica')
         .text(`${monthName} ${year}`, { align: 'center' });
      
      doc.moveDown(1);
      
      // ===== TABLEAU =====
      if (data && data.length > 0) {
        const tableTop = doc.y;
        const colWidths = [40, 70, 70, 70, 70, 80, 90]; // Jour, CB, ESP, TR, Dép, Total
        const tableWidth = colWidths.reduce((a, b) => a + b, 0);
        const startX = (doc.page.width - tableWidth) / 2;
        
        // En-têtes
        doc.fontSize(10).font('Helvetica-Bold');
        let x = startX;
        
        doc.fillColor('#333333')
           .rect(startX, tableTop, tableWidth, 20)
           .fill();
        
        doc.fillColor('#FFFFFF');
        ['Jour', 'CB', 'ESP', 'TR', 'Dép.', 'Total Décl.'].forEach((header, i) => {
          doc.text(header, x + 5, tableTop + 5, { width: colWidths[i] - 10, align: 'center' });
          x += colWidths[i];
        });
        
        // Lignes de données
        doc.fillColor('#000000').font('Helvetica');
        let y = tableTop + 25;
        
        data.forEach((row, index) => {
          x = startX;
          
          // Fond alterné
          if (index % 2 === 0) {
            doc.fillColor('#F5F5F5')
               .rect(startX, y - 3, tableWidth, 18)
               .fill();
          }
          
          doc.fillColor('#000000').fontSize(9);
          
          const values = [
            row.jour.toString(),
            formatMontant(row.cbDecl),
            formatMontant(row.espDecl),
            formatMontant(row.trDecl),
            formatMontant(row.depDecl),
            formatMontant(row.totalDecl)
          ];
          
          values.forEach((val, i) => {
            doc.text(val, x + 3, y, { width: colWidths[i] - 6, align: i === 0 ? 'center' : 'right' });
            x += colWidths[i];
          });
          
          y += 18;
          
          // Nouvelle page si nécessaire
          if (y > doc.page.height - 100) {
            doc.addPage();
            y = 50;
          }
        });
        
        // Ligne de total
        y += 5;
        doc.fillColor('#333333')
           .rect(startX, y - 3, tableWidth, 22)
           .fill();
        
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(10);
        x = startX;
        
        const totals = [
          'TOTAL',
          formatMontant(recap?.totalCB || 0),
          formatMontant(recap?.totalESP || 0),
          formatMontant(recap?.totalTR || 0),
          formatMontant(recap?.totalDep || 0),
          formatMontant(recap?.totalDeclare || 0)
        ];
        
        totals.forEach((val, i) => {
          doc.text(val, x + 3, y + 2, { width: colWidths[i] - 6, align: i === 0 ? 'center' : 'right' });
          x += colWidths[i];
        });
        
        doc.moveDown(3);
      } else {
        doc.fontSize(12).fillColor('#666666')
           .text('Aucune donnée pour ce mois.', { align: 'center' });
      }
      
      // ===== RÉSUMÉ =====
      if (recap) {
        doc.y = doc.page.height - 150;
        
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000')
           .text('Résumé', { align: 'left' });
        
        doc.moveDown(0.5);
        doc.fontSize(10).font('Helvetica');
        
        doc.text(`Total Cartes Bancaires : ${formatMontant(recap.totalCB)}`);
        doc.text(`Total Espèces : ${formatMontant(recap.totalESP)}`);
        doc.text(`Total Tickets Restaurant : ${formatMontant(recap.totalTR)}`);
        doc.text(`Total Dépenses : ${formatMontant(recap.totalDep)}`);
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold')
           .text(`TOTAL DÉCLARÉ : ${formatMontant(recap.totalDeclare)}`);
        doc.moveDown(0.5);
        doc.fontSize(9).font('Helvetica').fillColor('#666666')
           .text(`Jours d'activité : ${recap.joursRemplis}`);
      }
      
      // ===== PIED DE PAGE =====
      doc.fontSize(8).fillColor('#999999')
         .text(
           `Généré le ${new Date().toLocaleDateString('fr-FR')} - IArmy Compta`,
           40,
           doc.page.height - 30,
           { align: 'center', width: doc.page.width - 80 }
         );
      
      doc.end();
      
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { generatePDF };
