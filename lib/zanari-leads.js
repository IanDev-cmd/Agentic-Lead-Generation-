export const ZANARI_BATCH = 'zanari-analytics';

export const ZANARI_EXPLANATION = 'Zanari Analytics Ltd, based in Kilimani, Nairobi, sells business intelligence, data warehousing, and predictive analytics. These 20 leads are decision-makers and operating companies across financial services, transport, healthcare, retail, fleet, and the public sector in Kenya.';

const ROWS = [
  ['Diamond Trust Bank', 'dtbafrica.com', 'Philip G.', 'Chief Data Officer', 'Nairobi, Kenya', -1.3002, 36.7861, 'Leads enterprise-wide data strategy, governance, AI, and analytics transformation. High alignment with Zanari\'s BI, data warehousing, and predictive analytics offerings.'],
  ['Kenya Airways', 'kenya-airways.com', 'Billy Odera', 'Head of Data, Analytics & AI', 'Nairobi, Kenya', -1.3194, 36.9278, 'Actively leading the migration of on-premise data assets to scalable, secure cloud architectures and executing AI strategies in the transport and aviation sector.'],
  ['Jubilee Holdings Limited', 'jubileeinsurance.com', 'Dennis Kevogo', 'Head of Data & AI', 'Nairobi County, Kenya', -1.2868, 36.8172, 'Focuses on enterprise AI adoption, data governance, cloud architectures, and decision intelligence within insurance and financial services.'],
  ['I&M Bank Ltd', 'imbank.com', 'Gabriel Ayeni', 'Chief Data Officer', 'Nairobi County, Kenya', -1.2834, 36.8216, 'Spearheads advanced analytics, SQL and Python data transformations, and revenue-generating data initiatives.'],
  ['Britam', 'britam.com', 'Henry M.', 'Chief Digital & Technology Officer', 'Nairobi County, Kenya', -1.2928, 36.8084, 'Oversees digital transformation, responsible AI, and scalable digital platforms across insurance and asset management.'],
  ['Office of the Data Protection Commissioner', 'odpc.go.ke', 'Amos Kiptoo Kosgei', 'CIO / Deputy Data Commissioner ICT', 'Nairobi, Kenya', -1.2861, 36.8264, 'Public sector technology leader focused on IT governance, data governance, cybersecurity, and digital transformation.'],
  ['Safaricom PLC', 'safaricom.co.ke', 'James Maitai', 'Group Chief Technology & Information Officer', 'Nairobi County, Kenya', -1.2746, 36.8128, 'Leads enterprise-scale technology strategy, AI integration, and TechCo transformation.'],
  ['GTBank Kenya', 'gtbank.co.ke', 'Robert Rutahoile', 'Chief Information and Digital Transformation Officer', 'Nairobi County, Kenya', -1.2972, 36.8155, 'Directly responsible for banking digital transformation, core system integrations, and operational efficiency.'],
  ['Credit Bureau', '', 'Edna Mulwa', 'Chief Data Officer & Data Protection Officer', 'Nairobi, Kenya', -1.2895, 36.8042, 'Specializes in data quality improvement, reducing reporting turnaround times, and regulatory data compliance.'],
  ['Cellulant', 'cellulant.com', 'George Murage', 'Technology & Digital Payments Executive', 'Nairobi County, Kenya', -1.2788, 36.8234, 'Extensive background in scalable cloud infrastructure, DevOps, and enterprise system integrations across East Africa. Former CTO at Cellulant.'],
  ['Humming Bird Transport', '', '', 'Transport, fleet management, and hospitality logistics', 'Nairobi, Kenya', -1.3036, 36.7988, 'Operates a proprietary Hospitality Logistics System and an EV fleet. A fit for fleet dashboards, predictive maintenance analytics, and automated operational reporting.'],
  ['House of Procurement', '', '', 'Supply chain, logistics, healthcare, and industrial supplies', 'Nairobi, Kenya', -1.2714, 36.8066, 'Warehousing, inventory, and financing across several sectors need a central data warehouse and pipelines that remove data silos.'],
  ['ARN Security Consultants and Training Services LTD', '', '', 'Security, fleet management, and training', 'Naivasha / Nairobi, Kenya', -0.7172, 36.431, 'A large workforce and vehicle and fuel tracking create demand for automated KPI monitoring, custom enterprise apps, and BI reporting.'],
  ['Eighty Leverage Limited', '', '', 'Healthcare retail and pharmacy operations', 'Nairobi, Kenya', -1.2958, 36.7894, 'Scaling retail health hubs need procurement discipline, margin control, and real-time inventory and sales analytics.'],
  ['ORIGAMI TECH', '', '', 'Retail tech, warehouse management, and pharmacy systems', 'Nairobi, Kenya', -1.2812, 36.7906, 'Provides POS and warehouse tracking, including for pharmacy chains. A fit for a BI layer and demand forecasting.'],
  ['ITEC Engineering Ltd', '', '', 'Transport planning, infrastructure, and professional services', 'Nairobi, Kenya', -1.2688, 36.8198, 'Works on public-sector transport projects that involve traffic data, feasibility modeling, and GIS visualization.'],
  ['OSTATECH LTD', '', '', 'Fleet management, security, and IT services', 'Nairobi, Kenya', -1.3074, 36.8122, 'Real-time security, drones, and fleet management across healthcare, government, and education. A fit for integrations and custom portals.'],
  ['Brycom Limited', '', '', 'Telematics and fleet management', 'Kenya', -1.2742, 36.8312, 'Telematics produces streaming vehicle data that data engineering can turn into client-facing analytics.'],
  ['Finatrack Global Limited', '', '', 'GPS tracking, IoT, and fleet management', 'Nairobi, Kenya', -1.3118, 36.8246, 'Web and mobile tracking platforms can use custom software, API integrations, and predictive risk analytics.'],
  ['Kencrave', '', '', 'Business consulting, market intelligence, and data', 'Nairobi, Kenya', -1.2846, 36.7964, 'Turns emerging-market and FDI data into strategy. A fit for data pipelines, dashboards, and research tools.'],
];

export function zanariLeads() {
  return ROWS.map(([company, domain, contact, title, hq, lat, lng, why]) => ({
    company,
    domain,
    website: domain ? `https://${domain}` : '',
    hq,
    lat,
    lng,
    contact,
    title,
    email: '',
    pain: why,
    hook: why,
    priority: 'High',
    source: 'LinkedIn',
    interactionId: ZANARI_BATCH,
    negative: false,
  }));
}
