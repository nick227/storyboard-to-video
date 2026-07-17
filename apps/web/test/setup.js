require('dotenv').config();
process.env.DATABASE_URL ||= 'postgresql://storyboard:storyboard@localhost:5432/storyboard';
