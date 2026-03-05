/**
 * inSCADA Tool Definitions
 * Claude API tool_use formatında tool tanımları
 * inSCADA REST API + Chart
 */

const TOOLS = [
  // ==================== Space Management ====================
  {
    name: "set_space",
    description: "Aktif space'i değiştirir. Tüm API isteklerinde gönderilen X-Space header'ını günceller. Farklı bir space'teki verilere erişmek için önce bu tool ile space değiştirin.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    input_schema: {
      type: "object",
      properties: {
        space_name: { type: "string", description: "Space adı (Örn: default_space, production, test)" },
      },
      required: ["space_name"],
    },
  },
  // ==================== inSCADA Data Tools ====================
  {
    name: "list_spaces",
    description: "inSCADA space'leri listeler. Hiyerarşinin en üst seviyesi.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Space adında arama yapar (opsiyonel)" },
      },
    },
  },
  {
    name: "list_projects",
    description: "Bir space altındaki projeleri listeler.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        space_id: { type: "number", description: "Space ID" },
        space_name: { type: "string", description: "Space adı (kısmi eşleşme)" },
        search: { type: "string", description: "Proje adında arama (opsiyonel)" },
      },
    },
  },
  {
    name: "list_variables",
    description: "Bir projedeki tüm SCADA değişkenlerini (tag/point) listeler. Değişken adı, birimi, açıklaması, bağlantı bilgisi döner.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Project ID (workspace'ten otomatik alınabilir)" },
        search: { type: "string", description: "Değişken adı veya açıklamasında arama (opsiyonel)" },
        connection_id: { type: "number", description: "Connection ID ile filtreleme (opsiyonel)" },
        page_size: { type: "number", description: "Sayfa başına sonuç (varsayılan: 500, max: 2000)" },
        page_number: { type: "number", description: "Sayfa numarası (varsayılan: 0)" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "list_scripts",
    description: "Bir proje altındaki scriptleri listeler. Kod içeriği gösterilmez.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Project ID" },
        project_name: { type: "string", description: "Proje adı (kısmi eşleşme)" },
        space_name: { type: "string", description: "Space adı ile filtreleme" },
        search: { type: "string", description: "Script adında arama" },
      },
    },
  },
  {
    name: "get_script",
    description: "Bir scriptin tam kodunu ve detaylarını getirir.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        script_id: { type: "number", description: "Script ID" },
        script_name: { type: "string", description: "Script adı (kısmi eşleşme)" },
        project_name: { type: "string", description: "Proje adıyla daraltma" },
      },
    },
  },
  {
    name: "update_script",
    description: `Bir scriptin kodunu günceller. Önce get_script ile oku.

SCRIPT YAZMA KURALLARI:
- Motor: Nashorn ECMAScript 5 (JDK11). let/const, =>, template literal (\`\`), destructuring, async/await, class KULLANILAMAZ. Sadece var, function, for, if/else, try/catch kullan.
- YAPI (ZORUNLU): Tüm kod function bloğuna sarılmalı ve en altta çağrılmalı:
  function main() { /* kod */ }
  main();
- Global objeler: ins (SCADA API), user (kullanıcı), require(ins, "scriptName"), toJS(javaObj)
- ins.* API (sık kullanılanlar):
  ins.getVariableValue(name)→{value,date} | ins.setVariableValue(name,{value:N}) | ins.getVariableValues(names[])→{name:{value}}
  ins.toggleVariableValue(name) | ins.mapVariableValue(src,dest)
  ins.getConnectionStatus(name) | ins.startConnection(name) | ins.stopConnection(name)
  ins.getAlarmStatus(name) | ins.activateAlarmGroup(name) | ins.getLastFiredAlarms(index,count)
  ins.executeScript(name) | ins.getGlobalObject(name) | ins.setGlobalObject(name,obj)
  ins.writeLog(type,activity,msg) type:"INFO"/"WARN"/"ERROR"
  ins.sendMail(users[],subject,content) | ins.sendSMS(users[],msg) | ins.notify(type,title,msg)
  ins.now()→Date | ins.uuid() | ins.ping(addr,timeout) | ins.rest(method,url,contentType,body)
  ins.runSql(sql) | ins.writeToFile(name,text,append) | ins.readFile(name)
  ins.getLoggedVariableValuesByPage(names[],start,end,page,size) | ins.getLoggedVariableValueStats(names[],start,end)
- Java→JS dönüşüm: var list = toJS(ins.getVariables())
- projectName overload: çoğu method (projectName,...) ve (...) overload'u var, verilmezse script'in projesi kullanılır
- Anlık veri tarihi: ins.getVariableValue() dönüşündeki dateInMs epoch ms'dir. Doğru: var diffMs = ins.now().getTime() - varValue.dateInMs; date alanı Java Date objesidir, string parse güvenilir değildir.
- Tarihsel veri tarihi: ins.getLoggedVariableValuesByPage() dönüşündeki dttm alanı ISO 8601 string'dir (örn: "2026-03-03T23:53:23.508+03:00"), epoch ms DEĞİLDİR. Nashorn'da new Date(isoString) çalışmaz (NaN döner). Zaman bilgisi için: var timeStr = ("" + items[i].dttm).substring(11, 19); kullan.
- Tabulator/Chart desteği: Script'ler animation element'lere veri sağlayabilir. Animation element type=datatable ise script Tabulator-uyumlu JSON döndürmeli:
  return {
    table: JSON.stringify({columns:[{title:"Ad",field:"name"},{title:"Değer",field:"value"}], layout:"fitColumns", ...tabulatorConfig}),
    data: {0:{name:"Temp",value:25.3}, 1:{name:"Hum",value:60}},
    initTime: null,
    runTime: null,
    runTimeFunc: "updateOrAddData"
  };
  table: Tabulator config (JSON string), columns dizisi zorunlu. data: satır verileri (obje, key=index). runTimeFunc: güncelleme metodu (updateOrAddData/replaceData/cancelUpdate).
  initTime/runTime: Tabulator fonksiyon çağrıları JSON string (Örn: '{"addFilter":["value",">",10]}').
  Chart için: type=chart element'e {dataset:{0:{name,data,color,fill,step,configs,yAxisConfigs}},type:"line"|"bar"|"pie",labels:[],xAxes:{0:{labels:[]}},options:{backgroundColor,options:{}}} döndür.
- Chart veri hazırlama kuralları:
  Optimal nokta: chartWidthPx / 3 (min 50, max 600). Fazla veri varsa downsample yap.
  Label format: ≤1h → (""+dttm).substring(11,19) HH:mm:ss, ≤24h → .substring(11,16) HH:mm, >24h → .substring(5,10)+" "+.substring(11,16) MM-DD HH:mm.
  Logged data ters sıralı gelir (yeniden eskiye), chart için ters döngü (for i=len-1;i>=0;i--) kullan.
  require(ins,"name") fonksiyon property döndürmez, helper'ları inline yaz.
- Animasyon oluşturma (inscada_api ile):
  POST /api/animations body: {name, projectId, mainFlag:false, duration:2000, playOrder:1, svgContent:"<svg>...</svg>"}
  Element ekleme: POST /api/animations/{animationId}/elements body: {animationId, domId, name, dsc:null, type, expressionType, expression, status:true, props}
  Element type'ları (type, expressionType, props, expression dönüş değeri):
    Chart: type:"Chart", expressionType:"EXPRESSION", expression:"return ins.executeScript('name');", props:"{\\\"scriptId\\\":ID}" — script Chart.js JSON döndürür
    Datatable: type:"Datatable", aynı yapı — script Tabulator JSON döndürür
    Get: type:"Get", expressionType:"EXPRESSION", props:"{}" — value→textContent'e yazılır
    Color: type:"Color", expressionType:"SWITCH", props:'{"cases":{...}}' — renk formatları: "#hex", "red/blue"(blink), "#c1/#c2/gradient/horizontal"(gradient)
    Visibility: type:"Visibility", expressionType:"EXPRESSION", props:'{"inverse":false}' — value=boolean (true→görünür, inverse:true ise ters)
    Opacity: type:"Opacity", expressionType:"EXPRESSION", props:'{"min":0,"max":100}' — value=number, min-max aralığı 0-1 opacity'ye map edilir
    Bar: type:"Bar", expressionType:"EXPRESSION"|"TAG", props:'{"min":0,"max":100,"orientation":"Bottom","fillColor":"#04B3FF","duration":1,"opacity":1}' — orientation:"Bottom"|"Top"|"Left"|"Right". TAG modunda ek: variableName, default, isRadial, strokeWidth
    Rotate: type:"Rotate", expressionType:"EXPRESSION", props:'{"min":0,"max":360,"offset":"mc"}' — value=derece. offset=transform-origin: tl/tc/tr/ml/mc/mr/bl/bc/br
    Move: type:"Move", expressionType:"EXPRESSION", props:'{}' — value={orientation:"H"|"V",minVal,maxVal,minPos,maxPos,value,smoothOff} veya {type:"LINE",x1,y1,x2,y2,minVal,maxVal,value}
    Scale: type:"Scale", expressionType:"EXPRESSION", props:'{"min":0,"max":100,"horizontal":true,"vertical":true,"originXFactor":0.5,"originYFactor":0.5}' — value=number
    Blink: type:"Blink", expressionType:"EXPRESSION", props:'{"duration":500}' — value=boolean (true→yanıp söner)
    Pipe: type:"Pipe", expressionType:"EXPRESSION", props:'{}' — value={color:"#2196F3",speed:2,direction:1} yol boyunca akış animasyonu
    Animate: type:"Animate", expressionType:"EXPRESSION", props:'{"animationName":"bounce","duration":"1s","iterationCount":"infinite"}' — value=boolean (CSS animation)
    Tooltip: type:"Tooltip", expressionType:"EXPRESSION", props:'{"title":"","color":"#333","size":12,"delay":0}' — value=string (hover'da tooltip)
    Image: type:"Image", expressionType:"EXPRESSION", props:'{}' — value=URL veya base64 string
    Peity: type:"Peity", expressionType:"EXPRESSION", props:'{}' — value={type:"bar"|"line"|"pie"|"donut",data:[1,2,3],fill:["#color"]} inline sparkline
    GetSymbol: type:"GetSymbol", expressionType:"EXPRESSION", props:'{}' — value=symbol adı (SVG symbol yükler)
    QRCodeGeneration: type:"QRCodeGeneration", expressionType:"EXPRESSION", props:'{}' — value=string (QR kodu içeriği)
    Faceplate: type:"Faceplate", expressionType:"FACEPLATE", props:'{"faceplateName":"Name","alignment":"none","placeholderValues":{"ph1":"VarName1"}}'
    Iframe: type:"Iframe", expressionType:"EXPRESSION", props:'{}' — value=URL string
    Slider: type:"Slider", expressionType:"EXPRESSION", props:'{"variableName":"VarName","min":0,"max":100}' — kaydırma ile değer yazma
    Input: type:"Input", expressionType:"EXPRESSION", props:'{"variableName":"VarName"}' — metin/sayı girişi ile değer yazma
    Button: type:"Button", expressionType:"EXPRESSION", props:'{"label":"Buton","variableName":"VarName","value":1}' — tıkla→değer yaz
    AlarmIndication: type:"AlarmIndication", expressionType:"EXPRESSION", props:'{"alarmGroupName":"GroupName"}' — alarm durumuna göre renk göstergesi
    Access: type:"Access", props:'{"disable":true,"isRoles":true,"roles":[1,2]}' — rol tabanlı erişim kontrolü
    Click(SET): type:"Click", expressionType:"SET", props:'{"variableName":"VarName","value":1}' — tıkla→değişkene değer yaz
    Click(ANIMATION): type:"Click", expressionType:"ANIMATION", props:'{"animationName":"TargetAnim"}' — tıkla→animasyona git
    Click(SCRIPT): type:"Click", expressionType:"SCRIPT", props:'{"scriptId":123}' — tıkla→script çalıştır
    Menu: type:"Menu", expressionType:"EXPRESSION", props:'{"items":[{"label":"Item","action":"SET","variableName":"V","value":1}]}' — sağ tık menüsü
  KRİTİK: body'de animationId dahil edilmeli. dsc:null olabilir ama props asla null olamaz (en az "{}" gönder). SVG'deki rect/g/text id'leri domId olarak kullanılır.
  Animasyon varsayılanları: color:"#E8E8E8", alignment:"none".
- SVG animasyon oluşturma: Tüm animasyonlar 1920x1080 boyutunda olmalı. SVG tag zorunlu özellikleri: style="width:100%; height:100%;", viewBox="0 0 1920 1080", width="1920", height="1080". Eksik olursa sayfa taşar.`,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        script_id: { type: "number", description: "Script ID (zorunlu)" },
        code: { type: "string", description: "Yeni script kodu (tam kod). Nashorn ES5: function main(){...} main(); yapısı zorunlu." },
      },
      required: ["script_id", "code"],
    },
  },
  {
    name: "list_connections",
    description: "Projedeki connection (bağlantı) kayıtlarını listeler. include_status=true ile bağlantı durumlarını da getirir.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Project ID (opsiyonel, verilmezse tüm connection'lar)" },
        search: { type: "string", description: "Connection adında arama (opsiyonel)" },
        include_status: { type: "boolean", description: "Bağlantı durumlarını da getir (Connected/Disconnected)" },
      },
    },
  },
  {
    name: "search_in_scripts",
    description: "Tüm scriptlerde kod içi metin araması yapar.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        search_text: { type: "string", description: "Aranacak metin" },
        project_name: { type: "string", description: "Proje filtresi" },
      },
      required: ["search_text"],
    },
  },
  // ==================== Animation Tools ====================
  {
    name: "list_animations",
    description: "Bir projedeki animasyonları listeler. SVG içeriği dahil edilmez (hafif).",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Project ID" },
        project_name: { type: "string", description: "Proje adı (project_id yoksa kullanılır)" },
        search: { type: "string", description: "Animasyon adında arama (opsiyonel)" },
      },
    },
  },
  {
    name: "get_animation",
    description: "Bir animasyonun detaylarını, elementlerini ve scriptlerini getirir.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        animation_id: { type: "number", description: "Animation ID" },
        animation_name: { type: "string", description: "Animasyon adı (kısmi eşleşme, animation_id yoksa kullanılır)" },
        project_id: { type: "number", description: "Project ID (isimle arama için)" },
        include_svg: { type: "boolean", description: "SVG içeriğini dahil et (varsayılan: false)" },
        include_elements: { type: "boolean", description: "Elementleri dahil et (varsayılan: true)" },
      },
    },
  },
  // ==================== inSCADA REST API Tools ====================
  {
    name: "inscada_get_live_value",
    description: "Bir değişkenin CANLI (anlık, şu anki) değerini okur. Kullanıcı canlı/anlık/mevcut değer istediğinde BU TOOL kullanılmalıdır. project_id opsiyoneldir, verilmezse otomatik bulunur.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Proje ID (opsiyonel, verilmezse otomatik bulunur)" },
        variable_name: { type: "string", description: "Değişken adı" },
      },
      required: ["variable_name"],
    },
  },
  {
    name: "inscada_get_live_values",
    description: "Birden fazla değişkenin CANLI (anlık) değerlerini toplu okur. Çoklu canlı değer sorgusu için BU TOOL kullanılmalıdır. project_id opsiyoneldir, verilmezse otomatik bulunur.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Proje ID (opsiyonel, verilmezse otomatik bulunur)" },
        variable_names: { type: "string", description: "Virgülle ayrılmış değişken adları" },
      },
      required: ["variable_names"],
    },
  },
  {
    name: "inscada_set_value",
    description: "Değişkene değer yazar. DİKKAT: Gerçek ekipmana komut gönderir.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Proje ID" },
        variable_name: { type: "string", description: "Değişken adı" },
        value: { type: "number", description: "Yazılacak değer" },
      },
      required: ["project_id", "variable_name", "value"],
    },
  },
  {
    name: "inscada_get_fired_alarms",
    description: "Aktif alarmları listeler.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Proje ID (opsiyonel, verilmezse tüm alarmlar)" },
      },
    },
  },
  {
    name: "inscada_connection_status",
    description: "Connection bağlantı durumlarını kontrol eder.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        connection_ids: { type: "string", description: "Virgülle ayrılmış connection ID'leri" },
      },
      required: ["connection_ids"],
    },
  },
  {
    name: "inscada_project_status",
    description: "Proje çalışma durumunu kontrol eder.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Proje ID" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "inscada_run_script",
    description: "Scripti inSCADA üzerinde çalıştırır.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        script_id: { type: "number", description: "Script ID" },
      },
      required: ["script_id"],
    },
  },
  {
    name: "inscada_script_status",
    description: "Script çalışma durumunu kontrol eder.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        script_id: { type: "number", description: "Script ID" },
      },
      required: ["script_id"],
    },
  },
  {
    name: "inscada_logged_values",
    description: "Değişkenlerin tarihsel log verilerini çeker (REST API).",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        variable_ids: { type: "string", description: "Virgülle ayrılmış variable ID'leri" },
        start_date: { type: "string", description: "Başlangıç tarihi (ISO 8601)" },
        end_date: { type: "string", description: "Bitiş tarihi (ISO 8601)" },
      },
      required: ["variable_ids"],
    },
  },
  {
    name: "inscada_logged_stats",
    description: "Değişkenlerin istatistiklerini getirir (min, max, avg, sum, count, first, last). Günlük veya saatlik aralıkla.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Proje ID" },
        variable_names: { type: "string", description: "Virgülle ayrılmış değişken adları" },
        time_range: { type: "string", description: "Zaman aralığı (1h, 24h, 7d)" },
        start_date: { type: "string", description: "Başlangıç tarihi (ISO 8601, opsiyonel)" },
        end_date: { type: "string", description: "Bitiş tarihi (ISO 8601, opsiyonel)" },
        interval: { type: "string", enum: ["daily", "hourly"], description: "Gruplama aralığı (default: daily)" },
      },
      required: ["project_id", "variable_names"],
    },
  },

  // ==================== Chart Tools ====================
  {
    name: "chart_line",
    description: "Zaman serisi line chart üretir. Tarihsel veriyi REST API'den çeker.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    input_schema: {
      type: "object",
      properties: {
        variable_names: { type: "string", description: "Virgülle ayrılmış değişken adları" },
        project_id: { type: "number", description: "Proje ID" },
        time_range: { type: "string", description: "Zaman aralığı (1h, 6h, 24h, 7d)" },
        start_date: { type: "string", description: "Başlangıç tarihi (opsiyonel, time_range yerine)" },
        end_date: { type: "string", description: "Bitiş tarihi (opsiyonel)" },
        title: { type: "string" },
        y_label: { type: "string", description: "Y ekseni birimi" },
      },
      required: ["variable_names", "project_id"],
    },
  },
  {
    name: "chart_bar",
    description: "Bar chart üretir. Değişken bazlı karşılaştırma (istatistik).",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    input_schema: {
      type: "object",
      properties: {
        variable_names: { type: "string", description: "Virgülle ayrılmış değişken adları" },
        project_id: { type: "number", description: "Proje ID" },
        aggregation: { type: "string", description: "mean, max, min, sum, count (default: mean)" },
        time_range: { type: "string", description: "Zaman aralığı (1h, 24h, 7d)" },
        start_date: { type: "string", description: "Başlangıç tarihi (opsiyonel)" },
        end_date: { type: "string", description: "Bitiş tarihi (opsiyonel)" },
        title: { type: "string" },
        y_label: { type: "string" },
      },
      required: ["variable_names", "project_id"],
    },
  },
  {
    name: "chart_gauge",
    description: "Anlık değer gauge göstergesi. auto_refresh=true ile 2sn'de bir canlı güncelleme.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    input_schema: {
      type: "object",
      properties: {
        variable_name: { type: "string", description: "Değişken adı (tekil)" },
        project_id: { type: "number", description: "Proje ID" },
        min: { type: "number", description: "Min (default: 0)" },
        max: { type: "number", description: "Max (default: 100)" },
        title: { type: "string" },
        unit: { type: "string", description: "Birim" },
        auto_refresh: { type: "boolean", description: "Canlı güncelleme açık/kapalı (default: true)" },
      },
      required: ["variable_name", "project_id"],
    },
  },
  {
    name: "chart_multi",
    description: "Birden fazla seriyi aynı grafikte çizer.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    input_schema: {
      type: "object",
      properties: {
        series: {
          type: "array",
          description: "Seriler: [{variable_name, project_id, label}]",
          items: {
            type: "object",
            properties: {
              variable_name: { type: "string", description: "Değişken adı" },
              project_id: { type: "number", description: "Proje ID" },
              label: { type: "string", description: "Seri etiketi" },
            },
            required: ["variable_name", "project_id"],
          },
        },
        time_range: { type: "string", description: "Zaman aralığı (1h, 6h, 24h, 7d)" },
        start_date: { type: "string", description: "Başlangıç tarihi (opsiyonel)" },
        end_date: { type: "string", description: "Bitiş tarihi (opsiyonel)" },
        title: { type: "string" },
        y_label: { type: "string" },
      },
      required: ["series"],
    },
  },
  {
    name: "chart_forecast",
    description: "Tarihsel + tahmin grafiği. Tarihsel düz çizgi, tahmin kesikli çizgi. Önce veriyi analiz edip forecast_values üret.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    input_schema: {
      type: "object",
      properties: {
        variable_names: { type: "string", description: "Virgülle ayrılmış değişken adları" },
        project_id: { type: "number", description: "Proje ID" },
        time_range: { type: "string", description: "Tarihsel veri aralığı (6h, 24h, 7d)" },
        start_date: { type: "string", description: "Başlangıç tarihi (opsiyonel)" },
        end_date: { type: "string", description: "Bitiş tarihi (opsiyonel)" },
        forecast_values: {
          type: "array",
          description: "Tahmin noktaları [{x: ISO_timestamp, y: number}]",
          items: {
            type: "object",
            properties: {
              x: { type: "string", description: "ISO timestamp" },
              y: { type: "number", description: "Değer" },
            },
            required: ["x", "y"],
          },
        },
        forecast_label: { type: "string", description: "Tahmin etiketi (default: Tahmin)" },
        title: { type: "string" },
        y_label: { type: "string", description: "Y ekseni birimi" },
      },
      required: ["variable_names", "project_id", "forecast_values"],
    },
  },

  // ==================== Custom Menu Tools (REST API) ====================
  {
    name: "list_custom_menus",
    description: "Custom menüleri listeler (3 seviyeli hiyerarşi).",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Menü adında arama (opsiyonel)" },
      },
    },
  },
  {
    name: "get_custom_menu",
    description: "Custom menü detaylarını ve HTML içeriğini getirir.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        custom_menu_id: { type: "number", description: "Custom Menu ID" },
      },
      required: ["custom_menu_id"],
    },
  },
  {
    name: "get_custom_menu_by_name",
    description: "İsme göre custom menü arar ve detaylarını getirir.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Menü adı (tam eşleşme)" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_custom_menu",
    description: "Custom menü oluşturur. TEMPLATE KULLAN (gauge/line_chart/gauge_and_chart/multi_chart). Template varsa content gönderme.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Menü adı" },
        content: { type: "string", description: "HTML/JS/CSS içeriği (sadece template KULLANILMADIĞINDA)" },
        icon: { type: "string", description: "Font Awesome 5.x class (default: fas fa-industry)" },
        target: { type: "string", description: "Hedef konum (default: Home)" },
        position: { type: "string", enum: ["Top", "Bottom"], description: "Pozisyon (default: Bottom)" },
        menu_order: { type: "number", description: "Sıralama (default: 1)" },
        parent_menu_id: { type: "number", description: "Üst menü ID (2. seviye için)" },
        second_menu_id: { type: "number", description: "2. seviye ID (3. seviye için)" },
        template: { type: "string", enum: ["gauge", "line_chart", "gauge_and_chart", "multi_chart"], description: "Şablon tipi" },
        variable_name: { type: "string", description: "Template değişken adı" },
        project_id: { type: "number", description: "Template project ID" },
        title: { type: "string", description: "Dashboard başlığı" },
        unit: { type: "string", description: "Birim (kW, °C, bar, %)" },
        min: { type: "number", description: "Gauge min (default: 0)" },
        max: { type: "number", description: "Gauge max (default: 100)" },
        refresh_interval: { type: "number", description: "Yenileme ms (default: 2000)" },
        time_range: { type: "string", description: "Zaman penceresi (default: 1h)" },
        space_name: { type: "string", description: "Space adı (default: default_space)" },
        variables: {
          type: "array",
          description: "multi_chart template için değişken listesi",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Değişken adı" },
              label: { type: "string", description: "Gösterim etiketi (opsiyonel, varsayılan: name)" },
              color: { type: "string", description: "Çizgi rengi (opsiyonel, Örn: #3b82f6)" },
            },
            required: ["name"],
          },
        },
      },
      required: ["name"],
    },
  },
  {
    name: "update_custom_menu",
    description: "Custom menüyü günceller. Önce get_custom_menu ile oku. Template ile içerik yenilenebilir.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        custom_menu_id: { type: "number", description: "Custom Menu ID" },
        name: { type: "string", description: "Menü adı" },
        content: { type: "string", description: "HTML içeriği (template yoksa)" },
        icon: { type: "string", description: "Font Awesome icon class" },
        target: { type: "string", description: "Hedef konum" },
        position: { type: "string", description: "Pozisyon" },
        menu_order: { type: "number", description: "Sıralama" },
        parent_menu_id: { type: "number", description: "Üst menü ID" },
        second_menu_id: { type: "number", description: "2. seviye ID" },
        template: { type: "string", enum: ["gauge", "line_chart", "gauge_and_chart", "multi_chart"], description: "Şablon tipi" },
        variable_name: { type: "string", description: "Değişken adı" },
        project_id: { type: "number", description: "Project ID" },
        title: { type: "string", description: "Başlık" },
        unit: { type: "string", description: "Birim" },
        min: { type: "number", description: "Gauge min" },
        max: { type: "number", description: "Gauge max" },
        refresh_interval: { type: "number", description: "Yenileme ms" },
        time_range: { type: "string", description: "Zaman penceresi" },
        space_name: { type: "string", description: "Space adı" },
        variables: {
          type: "array",
          description: "multi_chart template için değişken listesi",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Değişken adı" },
              label: { type: "string", description: "Gösterim etiketi" },
              color: { type: "string", description: "Çizgi rengi" },
            },
            required: ["name"],
          },
        },
      },
      required: ["custom_menu_id"],
    },
  },
  {
    name: "delete_custom_menu",
    description: "Bir custom menüyü siler.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        custom_menu_id: { type: "number", description: "Custom Menu ID" },
        parent_menu_id: { type: "number", description: "Üst menü ID" },
        second_menu_id: { type: "number", description: "2. seviye ID" },
      },
      required: ["custom_menu_id"],
    },
  },

  // ==================== Export Tools ====================
  {
    name: "export_excel",
    description: "Veriyi Excel (.xlsx) olarak dışa aktarır. Birden fazla sheet destekler.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    input_schema: {
      type: "object",
      properties: {
        file_name: { type: "string", description: "Dosya adı (.xlsx uzantısız)" },
        sheets: {
          type: "array",
          description: "Excel sheet'leri. Her biri {name, headers, rows} içerir.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Sheet adı (max 31 karakter)" },
              headers: { type: "array", items: { type: "string" }, description: "Sütun başlıkları" },
              rows: { type: "array", items: { type: "array" }, description: "Satır verileri (2D dizi)" },
            },
            required: ["name", "headers", "rows"],
          },
        },
      },
      required: ["file_name", "sheets"],
    },
  },
  // ==================== Generic API Tools ====================
  {
    name: "inscada_api_endpoints",
    description: "inSCADA REST API endpoint keşfi. Arama/kategori/method ile doğru endpoint'i bul. 625 endpoint arasında filtrele.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Arama terimi (path, summary, tag içinde arar). Örn: 'alarm group', 'trend', 'report'" },
        category: { type: "string", description: "Kategori filtresi: alarms, variables, connections, scripts, projects, reports, visualization, trends, users, spaces, menus, expressions, data-transfer, custom, protocols, templates, system, other" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], description: "HTTP method filtresi" },
        tag: { type: "string", description: "OpenAPI tag filtresi (controller adı). Örn: 'alarm-group', 'trend-controller'" },
        limit: { type: "number", description: "Maksimum sonuç sayısı (varsayılan: 30, max: 50)" },
      },
    },
  },
  {
    name: "inscada_api_schema",
    description: "Bir endpoint'in parametre ve body şemasını gösterir. Endpoint'i çağırmadan önce hangi parametrelerin gerekli olduğunu öğrenmek için kullan.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Endpoint path (Örn: /api/alarms/groups)" },
        method: { type: "string", description: "HTTP method (varsayılan: GET)" },
      },
      required: ["path"],
    },
  },
  {
    name: "inscada_api",
    description: `inSCADA REST API'ye generic HTTP isteği gönderir. Herhangi bir /api/ endpoint'ine erişim sağlar. GET dışı istekler kullanıcı onayı gerektirir.

Animasyon oluşturma:
  POST /api/animations body:{name,projectId,mainFlag:false,duration:2000,playOrder:1,svgContent:"<svg>...</svg>",color:"#E8E8E8",alignment:"none"}
  Element ekleme: POST /api/animations/{animationId}/elements body:{animationId,domId,name,dsc:null,type,expressionType,expression,status:true,props}
  Script bağlama: POST /api/animations/{animationId}/scripts body:{type:"animation",scriptId:ID} ile script animasyona bağlanır. Bağlanan script'teki fonksiyonlar element expression'da direkt çağrılır: expression:"return bar();" (require kullanılmaz)
  Element type'ları (type, expressionType, props):
    Chart: type:"Chart", expressionType:"EXPRESSION", expression:"return ins.executeScript('name');", props:'{"scriptId":ID}'
    Datatable: type:"Datatable", aynı yapı (script Tabulator JSON döndürür)
    Get: type:"Get", expressionType:"EXPRESSION", props:'{}' — value→textContent
    Color: type:"Color", expressionType:"SWITCH" — renk: "#hex", "c1/c2"(blink), "c1/c2/gradient/horizontal"
    Visibility: type:"Visibility", expressionType:"EXPRESSION", props:'{"inverse":false}' — value=bool
    Opacity: type:"Opacity", expressionType:"EXPRESSION", props:'{"min":0,"max":100}' — value=number→opacity
    Bar: type:"Bar", expressionType:"EXPRESSION"|"TAG", props:'{"min":0,"max":100,"orientation":"Bottom","fillColor":"#04B3FF","duration":1,"opacity":1}' — orientation:"Bottom"|"Top"|"Left"|"Right"
    Rotate: type:"Rotate", expressionType:"EXPRESSION", props:'{"min":0,"max":360,"offset":"mc"}' — offset: tl/tc/tr/ml/mc/mr/bl/bc/br
    Move: type:"Move", expressionType:"EXPRESSION" — value={orientation:"H"|"V",minVal,maxVal,minPos,maxPos,value}
    Scale: type:"Scale", expressionType:"EXPRESSION", props:'{"min":0,"max":100,"horizontal":true,"vertical":true}'
    Blink: type:"Blink", expressionType:"EXPRESSION", props:'{"duration":500}' — value=bool
    Pipe: type:"Pipe", expressionType:"EXPRESSION" — value={color,speed,direction}
    Tooltip: type:"Tooltip", expressionType:"EXPRESSION", props:'{"title":"","color":"#333","size":12}'
    Image: type:"Image", expressionType:"EXPRESSION" — value=URL/base64
    Peity: type:"Peity", expressionType:"EXPRESSION" — value={type:"bar"|"line"|"pie",data:[],fill:["#c"]}
    Faceplate: type:"Faceplate", expressionType:"FACEPLATE", props:'{"faceplateName":"N","alignment":"none","placeholderValues":{"ph":"Var"}}'
    Slider: type:"Slider", props:'{"variableName":"V","min":0,"max":100}' | Input: type:"Input", props:'{"variableName":"V"}'
    Button: type:"Button", props:'{"label":"Text","variableName":"V","value":1}'
    AlarmIndication: type:"AlarmIndication", props:'{"alarmGroupName":"Group"}'
    Click(SET): type:"Click", expressionType:"SET", props:'{"variableName":"V","value":1}'
    Click(ANIMATION): type:"Click", expressionType:"ANIMATION", props:'{"animationName":"Target"}'
    Click(SCRIPT): type:"Click", expressionType:"SCRIPT", props:'{"scriptId":123}'
  Frame değişken değerleri: frameId ile direkt value okuyan endpoint yok. 2 adım: (1) inscada_api(POST, /api/variables/filter/pages, query_params:{pageSize:500}, body:{projectId:X, frameId:Y}) → variable listesi, (2) inscada_get_live_values(variable_names:"name1,name2,...") → canlı değerler.
  SVG ZORUNLU: <svg> tag'i şu 3 özelliği İÇERMELİ: style="width:100%; height:100%;" viewBox="0 0 1920 1080" width="1920" height="1080". Tam: <svg xmlns="http://www.w3.org/2000/svg" style="width:100%; height:100%;" width="1920" height="1080" viewBox="0 0 1920 1080">. Eksik olursa SVG taşar. Tüm element koordinatları 1920x1080 içinde kalmalı.
  KRİTİK: props asla null olamaz (en az "{}" gönder). SVG id'leri=domId.`,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    input_schema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], description: "HTTP method (varsayılan: GET)" },
        path: { type: "string", description: "API path (/api/ ile başlamalı). Path parametreleri {id} formatında. Örn: /api/projects/{id}/status" },
        query_params: { type: "object", description: "Query string parametreleri. Örn: {projectId: 52, groupName: 'test'}. Array değerler explode edilir." },
        body: { type: "object", description: "Request body (POST/PUT/PATCH için). JSON objesi." },
        path_params: { type: "object", description: "Path parametreleri. Örn: {id: 52} → /api/projects/52/status" },
      },
      required: ["path"],
    },
  },
  {
    name: "inscada_guide",
    description: "IMPORTANT: Call this tool FIRST before using any other inSCADA tool in a new conversation. Returns comprehensive usage guide including: Nashorn script rules (ECMAScript 5), ins.* API reference (30+ methods), animation element types (27 types), chart rules, custom menu rules, live value endpoints, tool priorities, and best practices. Without this guide you will make errors.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

module.exports = TOOLS;
