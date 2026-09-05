### **Topic Research Module (TRM)**

* [[Home]]

---

### **📐 Architecture & Core**
* [[Architecture & Data Model]]
* [[Security Guardrails & Root Safety]]
* [[Viking VFS & Tiered Compaction]]

---

### **🛠️ CLI & Ingestion**
* [[CLI Reference & Commands]]
* [[Multimodal Ingestion & Media Pipeline]]
* [[NotebookLM & Mining Pipeline]]

---

### **🔄 Workflows & Governance**
* [[Closed-Loop Gap Triage & RFC Synthesis]]
* [[Deployment & Automation]]

---

### **ℹ️ Quick Instructions**
1. **Scaffold Topic:**  
   `python scaffold_topic.py --topic <slug>`
2. **Audit Coverage:**  
   `python topic_coverage_auditor.py`
3. **Mine NotebookLM:**  
   `powershell scripts/run-ondemand-mine.ps1`
4. **Triage Gaps:**  
   `npm run trm:triage`
5. **Reconcile Fleet:**  
   `npm run fleet:wiki:reconcile`
