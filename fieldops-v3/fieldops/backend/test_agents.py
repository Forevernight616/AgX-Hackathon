import unittest
from agents import eligible

class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.t = dict(id='T1', status='idle', implements=['sprayer'], fuel=50, x=0, y=0, speed=1, travelBurn=1, workBurn=1)
        self.j = dict(id='J1', fieldId='F1', type='spray', duration=5, progress=0, deadline=30)
        self.f = [dict(id='F1', x=3, y=4)]
    def test_compatible(self):
        self.assertIsNotNone(eligible(self.t,self.j,self.f,0))
    def test_incompatible(self):
        self.j['type']='harvest';self.assertIsNone(eligible(self.t,self.j,self.f,0))
    def test_low_fuel(self):
        self.t['fuel']=2;self.assertIsNone(eligible(self.t,self.j,self.f,0))
    def test_deadline(self):
        self.j['deadline']=3;self.assertIsNone(eligible(self.t,self.j,self.f,0))
    def test_broken(self):
        self.t['status']='broken';self.assertIsNone(eligible(self.t,self.j,self.f,0))

if __name__=='__main__':unittest.main()
